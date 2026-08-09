/**
 * MatrixMcplServer — main MCPL server orchestrator.
 *
 * Handles the JSON-RPC main loop: initialize handshake, method dispatch,
 * and forwarding Matrix events to the connected host.
 *
 * Follows the pattern of slack-mcpl's SlackMcplServer, which follows
 * discord-mcpl's DiscordMcplServer; the Matrix domain logic lives in
 * matrix-adapter.ts and content.ts.
 */

import {
  McplConnection,
  textContent,
  method,
} from '@animalabs/mcpl-core';

import type {
  JsonRpcRequest,
  JsonRpcNotification,
  McplCapabilities,
  McplInitializeParams,
  McplInitializeResult,
  InitializeCapabilities,
  FeatureSetsUpdateParams,
  PushEventParams,
  ChannelsRegisterParams,
  ChannelsOpenParams,
  ChannelsOpenResult,
  ChannelsCloseParams,
  ChannelsCloseResult,
  ChannelsPublishParams,
  ChannelsPublishResult,
  ChannelsIncomingParams,
  ChannelsListResult,
  StateRollbackParams,
  StateRollbackResult,
  ChannelDescriptor,
  ContentBlock,
  ChannelsOutgoingChunkParams,
  ChannelsOutgoingCompleteParams,
} from '@animalabs/mcpl-core';

import type { MatrixAdapter, MatrixMessageData } from './matrix-adapter.js';
import { toolDefinitions } from './tools.js';
import { featureSets, isEnabled, featureSetForTool } from './feature-sets.js';
import { ChannelManager, mcplChannelId, parseMcplChannelId, toDescriptor } from './channels.js';
import { StateTracker } from './state.js';
import {
  fetchAttachmentBytes,
  mediaDownloadUrl,
  toFetchResult,
  type AttachmentRef,
} from './content.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Diagnostic file logger — bypasses the host's stderr capture. Set
// MATRIX_MCPL_DEBUG_LOG in the spawn env to a writable absolute path to
// enable; leave unset for no-op.
const _DEBUG_LOG_PATH = process.env.MATRIX_MCPL_DEBUG_LOG;
function dbg(tag: string, info: Record<string, unknown> = {}): void {
  if (!_DEBUG_LOG_PATH) return;
  try {
    appendFileSync(
      _DEBUG_LOG_PATH,
      `${new Date().toISOString()} ${tag} ${JSON.stringify(info)}\n`,
    );
  } catch {
    // Logging is best-effort; never break the server because of it.
  }
}

/** Where a publish to a room should land: inside the thread the conversation
 *  is currently in, or top-level when it isn't threaded. */
interface ThreadContext {
  threadRootId?: string;
  lastEventId: string;
}

export class MatrixMcplServer {
  private conn: McplConnection | null = null;
  private mcplEnabled = false;
  private enabledFeatureSets = new Set<string>();
  private channelManager = new ChannelManager();
  private stateTracker = new StateTracker();
  /** Buffers for channels/outgoing/chunk streams, keyed by inferenceId */
  private outgoingBuffers = new Map<string, { channelId: string; chunks: string[] }>();

  /** Rooms the agent has opted into for ambient (non-mention, non-DM) message
   *  delivery. Mentions and DMs always come through regardless — this only
   *  gates passive awareness of room chatter. Persisted to
   *  `MATRIX_SUBSCRIPTIONS_FILE` (a JSON array of room IDs) so the list
   *  survives restarts. */
  private subscribedRooms = new Set<string>();
  private subscriptionsLoaded = false;

  /** Per-room event ID of the newest message forwarded to the host this
   *  process. Used to bound the first-interaction backscroll fetch. In-memory
   *  only — resets on restart. */
  private forwardedWatermark = new Map<string, string>();

  /** Thread routing for host publishes: where the most recent incoming
   *  message sat. channels/publish carries no thread information, so "reply
   *  where the conversation is" is reconstructed here. */
  private lastIncomingThread = new Map<string, ThreadContext>();

  /** Most recently active room (either direction) — used to decide when an
   *  incoming message needs a location header. */
  private lastRoomId: string | null = null;

  /** How many backscroll messages to fetch on first interaction. Tunable via
   *  MATRIX_BACKSCROLL_LIMIT; clamped to [1, 1000], default 50. */
  private get backscrollLimit(): number {
    const raw = process.env.MATRIX_BACKSCROLL_LIMIT;
    if (!raw) return 50;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 && n <= 1000 ? n : 50;
  }

  constructor(private matrix: MatrixAdapter) {}

  /**
   * Serve a single connection. Blocks until the connection closes.
   * The Matrix adapter should already be connected before calling this.
   */
  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;

    // Set up Matrix event forwarding
    this.setupMatrixForwarding();

    // Handshake
    await this.handleInitialize();

    // If MCPL is enabled, register all joined Matrix rooms
    if (this.mcplEnabled) {
      await this.registerMatrixRooms();
    }

    // Main loop
    try {
      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        if (msg.type === 'request') {
          await this.handleRequest(msg.request);
        } else {
          this.handleNotification(msg.notification);
        }
      }
    } catch (err) {
      if ((err as Error).name === 'ConnectionClosedError') {
        console.error('[matrix-mcpl] Client disconnected');
      } else {
        console.error('[matrix-mcpl] Connection error:', err);
      }
    }

    this.conn = null;
  }

  // ── Initialize Handshake ──

  private async handleInitialize(): Promise<void> {
    const conn = this.conn!;

    // Wait for initialize request
    const msg = await conn.nextMessage();
    if (msg.type !== 'request' || msg.request.method !== 'initialize') {
      console.error('[matrix-mcpl] Expected initialize request, got:', msg);
      conn.close();
      return;
    }

    const params = msg.request.params as McplInitializeParams | undefined;

    // Detect MCPL support
    const clientMcpl = params?.capabilities?.experimental?.mcpl;
    this.mcplEnabled = clientMcpl !== undefined;
    dbg('handleInitialize', {
      mcplEnabled: this.mcplEnabled,
      clientName: params?.clientInfo?.name,
    });

    // Output routing ("where does a plain-text reply go") is a HOST concern —
    // the host publishes text-only turns to the conversational locus via
    // channels/publish, so no contextHooks are declared here (same rationale
    // as discord-mcpl and slack-mcpl; see LOCUS-ROUTING-DESIGN.md).
    const serverCaps: McplCapabilities = {
      version: '0.4',
      pushEvents: true,
      channels: true,
      rollback: true,
      featureSets,
    };

    const capabilities: InitializeCapabilities = {
      tools: {},
      ...(this.mcplEnabled && {
        experimental: { mcpl: serverCaps },
      }),
    };

    const result: McplInitializeResult = {
      protocolVersion: '2024-11-05',
      capabilities,
      serverInfo: { name: 'matrix-mcpl', version: '0.1.0' },
    };

    conn.sendResponse(msg.request.id, result);

    // Wait for initialized notification
    const initedMsg = await conn.nextMessage();
    if (initedMsg.type === 'notification' && initedMsg.notification.method === 'notifications/initialized') {
      console.error('[matrix-mcpl] Client initialized' + (this.mcplEnabled ? ' (MCPL mode)' : ' (MCP mode)'));
    }

    // In MCPL mode, default all feature sets to enabled
    if (this.mcplEnabled) {
      for (const fs of featureSets) {
        this.enabledFeatureSets.add(fs.name);
      }
    }
  }

  // ── Request Dispatch ──

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    const conn = this.conn!;
    const params = (req.params ?? {}) as Record<string, unknown>;

    try {
      switch (req.method) {
        case 'tools/list': {
          conn.sendResponse(req.id, { tools: toolDefinitions });
          break;
        }

        case 'tools/call': {
          const result = await this.handleToolCall(
            params.name as string,
            (params.arguments ?? {}) as Record<string, unknown>,
          );
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_LIST: {
          const result: ChannelsListResult = {
            channels: this.channelManager.getAll(),
          };
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_OPEN: {
          const openP = params as unknown as ChannelsOpenParams;
          const result = this.handleChannelOpen(openP);
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_CLOSE: {
          const closeP = params as unknown as ChannelsCloseParams;
          const closed = this.channelManager.close(closeP.channelId);
          const result: ChannelsCloseResult = { closed };
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CHANNELS_PUBLISH: {
          const pubP = params as unknown as ChannelsPublishParams;
          const result = await this.handlePublish(pubP);
          conn.sendResponse(req.id, result);
          break;
        }

        case method.STATE_ROLLBACK: {
          const rollbackP = params as unknown as StateRollbackParams;
          const result = await this.handleRollback(rollbackP);
          conn.sendResponse(req.id, result);
          break;
        }

        case method.CONTEXT_AFTER_INFERENCE: {
          // Not declared in capabilities; answered as a harmless no-op in
          // case an older host still calls it.
          conn.sendResponse(req.id, { featureSet: 'matrix.messaging' });
          break;
        }

        default:
          conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      // Report with full context — tool name, truncated args, stack — so
      // transient failures (homeserver 5xx, rate limits, missing power
      // levels) are traceable from the host side.
      const e = err as Error;
      const isToolsCall = req.method === 'tools/call';
      const toolName = isToolsCall ? (params.name as string | undefined) : undefined;
      const toolArgs = isToolsCall
        ? (params.arguments as Record<string, unknown> | undefined)
        : undefined;
      console.error(
        `[matrix-mcpl] handleRequest error: method=${req.method}`,
        toolName ? `tool=${toolName}` : '',
        e.stack ?? e.message,
      );
      dbg('handleRequest:error', {
        method: req.method,
        tool: toolName,
        args: toolArgs
          ? Object.fromEntries(
              Object.entries(toolArgs).map(([k, v]) => [
                k,
                typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v,
              ]),
            )
          : undefined,
        error: e.message,
        stack: e.stack?.split('\n').slice(0, 8).join('\n'),
      });
      conn.sendError(req.id, -32603, e.message);
    }
  }

  // ── Notification Dispatch ──

  private handleNotification(notif: JsonRpcNotification): void {
    switch (notif.method) {
      case method.FEATURE_SETS_UPDATE: {
        const p = notif.params as FeatureSetsUpdateParams;
        if (p.enabled) {
          for (const name of p.enabled) this.enabledFeatureSets.add(name);
        }
        if (p.disabled) {
          for (const name of p.disabled) this.enabledFeatureSets.delete(name);
        }
        break;
      }

      case method.CHANNELS_OUTGOING_CHUNK: {
        const p = notif.params as ChannelsOutgoingChunkParams;
        const buf = this.outgoingBuffers.get(p.inferenceId);
        if (buf) {
          buf.chunks[p.index] = p.delta;
        } else {
          const chunks: string[] = [];
          chunks[p.index] = p.delta;
          this.outgoingBuffers.set(p.inferenceId, { channelId: p.channelId, chunks });
        }
        break;
      }

      case method.CHANNELS_OUTGOING_COMPLETE: {
        const p = notif.params as ChannelsOutgoingCompleteParams;
        this.outgoingBuffers.delete(p.inferenceId);

        // Extract text and send to Matrix (into the active thread, if any)
        const text = p.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n');

        if (text) {
          const parsed = parseMcplChannelId(p.channelId);
          if (parsed) {
            const ctx = this.lastIncomingThread.get(parsed.roomId);
            this.matrix
              .sendMessage(parsed.roomId, text, ctx?.threadRootId ? { threadRootId: ctx.threadRootId } : {})
              .catch((err) => {
                console.error('[matrix-mcpl] outgoing/complete send failed:', (err as Error).message);
              });
          }
        }
        break;
      }

      // Matrix has real typing notifications, so the agent's "thinking"
      // state is visible to humans in the room.
      case 'channels/typing':
      case 'notifications/typing': {
        const p = (notif.params ?? {}) as { channelId?: string; typing?: boolean };
        const parsed = p.channelId ? parseMcplChannelId(p.channelId) : null;
        if (parsed) {
          this.matrix
            .setTyping(parsed.roomId, p.typing !== false)
            .catch(() => { /* cosmetic — never surface a typing failure */ });
        }
        break;
      }

      default:
        // Ignore unknown notifications
        break;
    }
  }

  // ── Tool Call Handling ──

  private async handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: ContentBlock[]; isError?: boolean; state?: unknown }> {
    // Check feature set permission
    const fs = featureSetForTool(name);
    if (fs && this.mcplEnabled && !isEnabled(fs, this.enabledFeatureSets)) {
      return {
        content: [textContent(`Feature set '${fs}' is not enabled`)],
        isError: true,
      };
    }

    try {
      const result = await this.executeToolCall(name, args);

      // fetch_attachment returns native content blocks (images) via _content
      if (result && typeof result === 'object' && '_content' in (result as Record<string, unknown>)) {
        return { content: (result as { _content: ContentBlock[] })._content };
      }

      // Track checkpoints for rollback-enabled tools
      if (fs === 'matrix.messaging') {
        const cpId = this.stateTracker.createCheckpoint();
        return {
          content: [textContent(typeof result === 'string' ? result : JSON.stringify(result))],
          state: { checkpoint: cpId },
        };
      }

      return {
        content: [textContent(typeof result === 'string' ? result : JSON.stringify(result))],
      };
    } catch (err) {
      return {
        content: [textContent((err as Error).message)],
        isError: true,
      };
    }
  }

  private async executeToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (name) {
      case 'send_message': {
        const roomId = await this.matrix.resolveRoom(this.requireString(args, 'roomId'));
        const content = this.requireString(args, 'content');
        const result = await this.matrix.sendMessage(roomId, content, {
          notice: args.notice === true,
        });
        this.stateTracker.recordSent(result.eventId, roomId, content);
        this.markOutbound(roomId);
        return { eventId: result.eventId, roomId };
      }

      case 'reply_message': {
        const roomId = await this.matrix.resolveRoom(this.requireString(args, 'roomId'));
        const content = this.requireString(args, 'content');
        const eventId = this.requireString(args, 'eventId');
        // Threaded by default: a thread keeps a long agent exchange out of the
        // room's main timeline, which is what humans want from a busy bot.
        const threaded = args.thread !== false;
        const result = await this.matrix.sendMessage(
          roomId,
          content,
          threaded ? { threadRootId: eventId } : { replyToId: eventId },
        );
        this.stateTracker.recordSent(result.eventId, roomId, content);
        this.markOutbound(roomId);
        return { eventId: result.eventId, ...(threaded ? { threadRootId: eventId } : { replyTo: eventId }) };
      }

      case 'send_dm': {
        const userId = this.requireString(args, 'userId');
        const content = this.requireString(args, 'content');
        const result = await this.matrix.sendDM(userId, content);
        this.stateTracker.recordSent(result.eventId, result.roomId, content);
        this.markOutbound(result.roomId);
        await this.registerRoom(result.roomId);
        return { eventId: result.eventId, roomId: result.roomId };
      }

      case 'add_reaction':
        await this.matrix.addReaction(
          await this.matrix.resolveRoom(this.requireString(args, 'roomId')),
          this.requireString(args, 'eventId'),
          this.requireString(args, 'emoji'),
        );
        return 'Reaction added';

      case 'edit_message':
        await this.matrix.editMessage(
          await this.matrix.resolveRoom(this.requireString(args, 'roomId')),
          this.requireString(args, 'eventId'),
          this.requireString(args, 'content'),
        );
        return 'Message edited';

      case 'delete_message':
        await this.matrix.redactEvent(
          await this.matrix.resolveRoom(this.requireString(args, 'roomId')),
          this.requireString(args, 'eventId'),
          typeof args.reason === 'string' ? args.reason : undefined,
        );
        return 'Message redacted';

      case 'list_rooms': {
        const rooms = await this.matrix.listRooms();
        return rooms.map((r) => ({
          roomId: r.roomId,
          kind: r.kind,
          name: r.kind === 'dm' ? `DM: ${r.name}` : r.name,
          ...(r.alias ? { alias: r.alias } : {}),
          ...(r.topic ? { topic: r.topic } : {}),
          ...(r.memberCount !== undefined ? { memberCount: r.memberCount } : {}),
          ...(r.encrypted ? { encrypted: true, note: 'Encrypted — messages cannot be read by this server.' } : {}),
        }));
      }

      case 'refresh_rooms':
        return await this.refreshRooms();

      case 'join_room': {
        const roomId = await this.matrix.joinRoom(this.requireString(args, 'roomIdOrAlias'));
        const added = await this.registerRoom(roomId);
        return {
          roomId,
          registered: added,
          note: added
            ? 'Joined and registered as a channel.'
            : 'Joined; the host already knew this room.',
        };
      }

      case 'leave_room': {
        const roomId = await this.matrix.resolveRoom(this.requireString(args, 'roomId'));
        await this.matrix.leaveRoom(roomId);
        this.channelManager.unregister(mcplChannelId(roomId));
        this.ensureSubscriptionsLoaded();
        if (this.subscribedRooms.delete(roomId)) this.saveSubscriptions();
        if (this.conn && this.mcplEnabled) {
          this.conn.sendNotification(method.CHANNELS_CHANGED, { removed: [mcplChannelId(roomId)] });
        }
        return `Left ${roomId}.`;
      }

      case 'fetch_history': {
        const roomId = await this.matrix.resolveRoom(this.requireString(args, 'roomId'));
        const { messages, truncated } = await this.matrix.fetchHistory(roomId, {
          limit: (args.limit as number) ?? 50,
          ...(args.beforeEventId ? { beforeEventId: args.beforeEventId as string } : {}),
        });
        return {
          messages: messages.map((m) => this.renderHistoryMessage(m)),
          ...(truncated ? { note: 'Range holds more messages than the limit; the oldest were omitted.' } : {}),
        };
      }

      case 'fetch_thread': {
        const roomId = await this.matrix.resolveRoom(this.requireString(args, 'roomId'));
        const threadRootId = this.requireString(args, 'threadRootId');
        const { messages, truncated } = await this.matrix.fetchThread(
          roomId,
          threadRootId,
          (args.limit as number) ?? 100,
        );
        return {
          messages: messages.map((m) => this.renderHistoryMessage(m)),
          ...(truncated ? { note: 'Thread holds more messages than the limit; the newest were omitted.' } : {}),
        };
      }

      case 'find_user': {
        const matches = await this.matrix.findUsers(this.requireString(args, 'query'));
        if (matches.length === 0) {
          return {
            found: false,
            note:
              'No users matched. The directory only covers users sharing a room with the bot ' +
              'plus published profiles — try the full @user:server if you know it.',
          };
        }
        return {
          found: true,
          users: matches.map((u) => ({
            userId: u.userId,
            displayName: u.displayName,
            mentionSyntax: u.userId,
          })),
        };
      }

      case 'fetch_attachment': {
        // Media is addressed by mxc:// URI and always fetched from the
        // configured homeserver — the access token has nowhere else to go.
        const mxcUrl = this.requireString(args, 'mxcUrl');
        const url = mediaDownloadUrl(this.matrix.homeserverUrl, mxcUrl);
        const name = (typeof args.name === 'string' && args.name) || mxcUrl.split('/').pop() || 'attachment';
        return toFetchResult(
          await fetchAttachmentBytes(url, name, {
            headers: { Authorization: `Bearer ${this.matrix.accessToken}` },
          }),
        );
      }

      case 'subscribe_room': {
        this.ensureSubscriptionsLoaded();
        const roomId = await this.matrix.resolveRoom(this.requireString(args, 'roomId'));
        const wasNew = !this.subscribedRooms.has(roomId);
        this.subscribedRooms.add(roomId);
        if (wasNew) this.saveSubscriptions();
        return wasNew
          ? `Subscribed to ambient messages from room ${roomId}.`
          : `Already subscribed to room ${roomId}.`;
      }

      case 'unsubscribe_room': {
        this.ensureSubscriptionsLoaded();
        const roomId = await this.matrix.resolveRoom(this.requireString(args, 'roomId'));
        const removed = this.subscribedRooms.delete(roomId);
        if (removed) this.saveSubscriptions();
        return removed
          ? `Unsubscribed from ambient messages in room ${roomId}. Mentions and DMs from there will still arrive.`
          : `Room ${roomId} was not subscribed.`;
      }

      case 'list_subscriptions': {
        this.ensureSubscriptionsLoaded();
        return {
          rooms: [...this.subscribedRooms].sort(),
          count: this.subscribedRooms.size,
          note:
            this.subscribedRooms.size === 0
              ? 'No ambient subscriptions. Mentions and DMs are always delivered.'
              : 'Ambient messages from these rooms are delivered. Mentions and DMs always come through regardless.',
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private requireString(args: Record<string, unknown>, key: string): string {
    const v = args[key];
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`${key} is required`);
    }
    return v;
  }

  private renderHistoryMessage(m: {
    id: string; authorName: string; content: string; threadRootId?: string;
    timestamp: Date; attachments: Array<{ name: string; mimeType?: string; url?: string }>;
  }): Record<string, unknown> {
    return {
      id: m.id,
      author: m.authorName,
      timestamp: m.timestamp.toISOString(),
      ...(m.threadRootId ? { threadRootId: m.threadRootId } : {}),
      content: m.content,
      ...(m.attachments.length > 0
        ? {
            attachments: m.attachments.map((a) =>
              `${a.name}${a.mimeType ? ` (${a.mimeType})` : ''}${a.url ? ` — fetchable via fetch_attachment: ${a.url}` : ''}`,
            ),
          }
        : {}),
    };
  }

  /** Record that the bot just sent to a room, for location headers. */
  private markOutbound(roomId: string): void {
    this.lastRoomId = roomId;
  }

  // ── Subscription persistence ──

  /** Path to the JSON file backing ambient subscriptions.
   *  When unset, subscriptions are in-memory only (lost on restart). */
  private subscriptionsFile(): string | undefined {
    const p = process.env.MATRIX_SUBSCRIPTIONS_FILE;
    return p && p.length > 0 ? p : undefined;
  }

  /** Lazy-load subscriptions from disk on first access. Idempotent. */
  private ensureSubscriptionsLoaded(): void {
    if (this.subscriptionsLoaded) return;
    this.subscriptionsLoaded = true;
    const path = this.subscriptionsFile();
    if (!path || !existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === 'string' && id.length > 0) this.subscribedRooms.add(id);
        }
      }
      dbg('subscriptions:loaded', { count: this.subscribedRooms.size, path });
    } catch (err) {
      // Corrupt or unreadable file: start with empty set; don't fail boot.
      console.error('[matrix-mcpl] Failed to load subscriptions:', (err as Error).message);
    }
  }

  private saveSubscriptions(): void {
    const path = this.subscriptionsFile();
    if (!path) return; // in-memory mode
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify([...this.subscribedRooms].sort(), null, 2) + '\n');
    } catch (err) {
      console.error('[matrix-mcpl] Failed to save subscriptions:', (err as Error).message);
    }
  }

  private isRoomSubscribed(roomId: string): boolean {
    this.ensureSubscriptionsLoaded();
    return this.subscribedRooms.has(roomId);
  }

  // ── Channel Operations ──

  private async registerMatrixRooms(): Promise<void> {
    const conn = this.conn;
    if (!conn || !this.mcplEnabled) return;

    let descriptors: ChannelDescriptor[] = [];
    try {
      const rooms = await this.matrix.listRooms();
      descriptors = rooms.map((r) => toDescriptor(r, this.matrix.serverName));
      const encrypted = rooms.filter((r) => r.encrypted);
      if (encrypted.length > 0) {
        console.error(
          `[matrix-mcpl] ${encrypted.length} joined room(s) are end-to-end encrypted and cannot ` +
            `be read: ${encrypted.map((r) => r.name).join(', ')}`,
        );
      }
    } catch (err) {
      console.error('[matrix-mcpl] Failed to enumerate rooms:', (err as Error).message);
      return;
    }
    dbg('registerMatrixRooms', { count: descriptors.length });
    if (descriptors.length === 0) return;

    this.channelManager.registerAll(descriptors);

    const regParams: ChannelsRegisterParams = { channels: descriptors };
    try {
      await conn.sendRequest(method.CHANNELS_REGISTER, regParams);
    } catch (err) {
      console.error('[matrix-mcpl] Failed to register channels:', (err as Error).message);
    }
  }

  /** Register the given descriptors and emit a single `channels/changed`
   *  notification for the ones that weren't already known. Idempotent:
   *  re-registering a known channel refreshes its descriptor but does NOT
   *  re-announce it. Returns the descriptors that were newly added. */
  private registerAndNotifyNew(descriptors: ChannelDescriptor[]): ChannelDescriptor[] {
    const added: ChannelDescriptor[] = [];
    for (const d of descriptors) {
      if (!this.channelManager.get(d.id)) added.push(d);
      this.channelManager.register(d);
    }
    if (added.length > 0 && this.conn && this.mcplEnabled) {
      this.conn.sendNotification(method.CHANNELS_CHANGED, { added });
    }
    return added;
  }

  /** Register one room by ID (after a join or a new DM). Returns true when the
   *  host didn't already know it. */
  private async registerRoom(roomId: string): Promise<boolean> {
    if (!this.mcplEnabled) return false;
    const meta = await this.matrix.getRoomMeta(roomId);
    if (!meta) return false;
    return this.registerAndNotifyNew([toDescriptor(meta, this.matrix.serverName)]).length > 0;
  }

  /** Re-enumerate every joined room and register any the host doesn't yet
   *  know about — the agent-facing catch-all for "I was invited to a room but
   *  don't see it". */
  private async refreshRooms(): Promise<{
    joined: number;
    added: Array<{ id: string; label: string }>;
    note: string;
  }> {
    const rooms = await this.matrix.listRooms();
    const descriptors = rooms.map((r) => toDescriptor(r, this.matrix.serverName));
    const added = this.registerAndNotifyNew(descriptors);
    return {
      joined: descriptors.length,
      added: added.map((d) => ({ id: d.id, label: d.label })),
      note:
        added.length > 0
          ? `Registered ${added.length} newly-visible room(s).`
          : 'No new rooms — the host already knows about every joined one.',
    };
  }

  private handleChannelOpen(params: ChannelsOpenParams): ChannelsOpenResult {
    const addr = params.address as { roomId?: string } | undefined;
    if (params.type === 'matrix' && addr?.roomId) {
      const desc = this.channelManager.openByRoomId(addr.roomId);
      if (desc) {
        return { channel: desc };
      }
    }

    // Fall back to the first registered channel of the requested type
    for (const desc of this.channelManager.getAll()) {
      if (desc.type === params.type) {
        this.channelManager.open(desc.id);
        return { channel: desc };
      }
    }

    throw new Error('No matching channel found');
  }

  private async handlePublish(params: ChannelsPublishParams): Promise<ChannelsPublishResult> {
    const parsed = parseMcplChannelId(params.channelId);
    if (!parsed) {
      throw new Error(`Invalid channel ID: ${params.channelId}`);
    }

    // Extract text from content blocks
    const text = params.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    if (!text) {
      dbg('handlePublish:skip', { channelId: params.channelId, reason: 'empty-text' });
      return { delivered: false, messageId: undefined };
    }

    // Reply in the thread of the most recent incoming message on this room;
    // top-level when the conversation isn't threaded.
    const ctx = this.lastIncomingThread.get(parsed.roomId);
    const result = await this.matrix.sendMessage(
      parsed.roomId,
      text,
      ctx?.threadRootId ? { threadRootId: ctx.threadRootId } : {},
    );
    this.stateTracker.recordSent(result.eventId, parsed.roomId, text);
    this.markOutbound(parsed.roomId);
    // The agent has finished its turn; drop the typing indicator it raised.
    this.matrix.setTyping(parsed.roomId, false).catch(() => {});
    dbg('handlePublish:sent', {
      channelId: params.channelId,
      eventId: result.eventId,
      threadRootId: ctx?.threadRootId,
    });

    return { delivered: true, messageId: result.eventId };
  }

  // ── Rollback ──

  private async handleRollback(params: StateRollbackParams): Promise<StateRollbackResult> {
    if (params.featureSet !== 'matrix.messaging') {
      return {
        checkpoint: params.checkpoint,
        success: false,
        reason: `Feature set '${params.featureSet}' does not support rollback`,
      };
    }

    const toRedact = this.stateTracker.rollback(params.checkpoint);
    if (toRedact === null) {
      return {
        checkpoint: params.checkpoint,
        success: false,
        reason: 'Checkpoint not found',
      };
    }

    // Redaction of one's own events is always permitted, so this is reliable
    // in a way Slack's delete-window is not — but a redaction tombstone stays
    // visible to anyone who was looking.
    let redacted = 0;
    for (const msg of toRedact) {
      try {
        await this.matrix.redactEvent(msg.roomId, msg.messageId, 'rolled back');
        redacted++;
      } catch {
        // Best-effort — the event may already be gone.
      }
    }

    return {
      checkpoint: params.checkpoint,
      success: true,
      reason: redacted < toRedact.length
        ? `Rolled back (${redacted}/${toRedact.length} messages redacted)`
        : undefined,
    };
  }

  // ── Matrix Event Forwarding ──

  private setupMatrixForwarding(): void {
    this.matrix.onMessage((msg) => {
      this.handleMatrixMessage(msg).catch((err) => {
        console.error('[matrix-mcpl] Error forwarding Matrix message:', err);
      });
    });

    // A join (invite accepted, or a room renamed) should reach the host
    // without the agent having to call refresh_rooms.
    this.matrix.onRoomsChanged((roomId) => {
      this.registerRoom(roomId).catch((err) => {
        console.error('[matrix-mcpl] Failed to register room:', (err as Error).message);
      });
    });
  }

  /** Render attachment refs as a text block the agent can act on. Matrix media
   *  needs an authenticated fetch against the homeserver, so bytes are pulled
   *  on demand via fetch_attachment rather than inlined here. */
  private attachmentNote(attachments: AttachmentRef[]): string {
    const lines = attachments.map((a) =>
      `- ${a.name} (${a.mimeType})${a.isImage ? ' — image' : ''}${a.size ? `, ${a.size} bytes` : ''}, fetchable via fetch_attachment: ${a.path}`,
    );
    return `[attachments: ${attachments.length}]\n${lines.join('\n')}`;
  }

  private async handleMatrixMessage(msg: MatrixMessageData): Promise<void> {
    const conn = this.conn;
    dbg('handleMatrixMessage:enter', {
      msgId: msg.id,
      roomId: msg.roomId,
      authorId: msg.authorId,
      mentionsBot: msg.mentionsBot,
      isDM: msg.isDM,
      hasConn: !!conn,
      mcplEnabled: this.mcplEnabled,
    });
    if (!conn) return;
    if (!this.mcplEnabled) return; // No push events in MCP-only mode
    if (!isEnabled('matrix.messaging', this.enabledFeatureSets)) return;

    // Direct address (mention or DM) always reaches the agent. Ambient
    // messages only flow from subscribed rooms — otherwise every joined room
    // would pour unbounded noise into context. The wake decision is the
    // host's, via the chat:* tags below.
    const isAddressed = msg.mentionsBot || msg.isDM;
    if (!isAddressed && !this.isRoomSubscribed(msg.roomId)) {
      dbg('handleMatrixMessage:drop', { reason: 'ambient-not-subscribed', roomId: msg.roomId });
      return;
    }

    // First-interaction handling: when about to forward the very first
    // message from this room (this process), pull backscroll for context.
    // For rooms reached via mention, also auto-subscribe and emit a system
    // note. DMs always come through, so no subscription note for them.
    this.ensureSubscriptionsLoaded();
    const isFirstInteraction = !this.forwardedWatermark.has(msg.roomId);
    let prefixBlock = '';
    if (isFirstInteraction && isAddressed) {
      let backscroll: Awaited<ReturnType<typeof this.matrix.fetchBackscroll>> = [];
      try {
        // Anchored on the triggering event, so it is never included itself.
        backscroll = await this.matrix.fetchBackscroll(msg.roomId, msg.id, this.backscrollLimit);
        // Drop the bot's own past messages — already in the agent's
        // chronicle as assistant turns, no need to re-echo.
        backscroll = backscroll.filter((m) => m.authorId !== this.matrix.userId);
      } catch (err) {
        dbg('backscroll:fetch-failed', { roomId: msg.roomId, error: (err as Error).message });
      }

      const meta = await this.matrix.getRoomMeta(msg.roomId);
      const blocks: string[] = [];
      if (!msg.isDM) {
        const where = meta?.alias ?? meta?.name ?? `room ${msg.roomId}`;
        const wasSubscribed = this.subscribedRooms.has(msg.roomId);
        if (!wasSubscribed) {
          this.subscribedRooms.add(msg.roomId);
          this.saveSubscriptions();
          blocks.push(
            `<system>Auto-subscribed to ${where} because you were mentioned. ` +
              `Ambient (non-mention) messages from this room will now arrive in your context. ` +
              `Mentions and DMs always come through regardless of subscriptions. ` +
              `To stop ambient delivery from here: unsubscribe_room("${msg.roomId}").</system>`,
          );
        }
      }
      if (backscroll.length > 0) {
        const attrs: string[] = [];
        if (meta && !msg.isDM) attrs.push(`room="${meta.alias ?? meta.name}"`);
        if (msg.isDM) attrs.push('dm="true"');
        attrs.push(`count="${backscroll.length}"`);
        const lines = backscroll.map((m) => {
          const att = m.attachments.length > 0
            ? ` [attachments: ${m.attachments.map((a) => a.name).join(', ')}]`
            : '';
          const threadMark = m.threadRootId ? ' (thread reply)' : '';
          return `[${m.timestamp.toISOString()} id=${m.id}]${threadMark} ${m.authorName}: ${m.content}${att}`;
        });
        blocks.push([`<backscroll ${attrs.join(' ')}>`, ...lines, '</backscroll>'].join('\n'));
      }
      if (blocks.length > 0) {
        prefixBlock = blocks.join('\n') + '\n';
      }
    }

    const channelMcplId = mcplChannelId(msg.roomId);
    const channelIsOpen = this.channelManager.isOpen(channelMcplId);

    // Location header only when the room differs from the last communication
    // context (compare BEFORE updating the tracker).
    const contextChanged = this.lastRoomId !== msg.roomId;
    let location = '';
    if (contextChanged) {
      const meta = await this.matrix.getRoomMeta(msg.roomId);
      const parts: string[] = [];
      if (msg.isDM) parts.push('DM');
      else if (meta) parts.push(meta.alias ?? meta.name);
      if (msg.threadRootId) parts.push('in thread');
      parts.push(`(${this.matrix.serverName})`);
      if (parts.length > 0) location = `[${parts.join(' ')}] `;
    }
    // m.emote is the /me form — "* alice waves" rather than "alice: waves".
    const renderedContent =
      msg.msgtype === 'm.emote'
        ? `${prefixBlock}${location}* ${msg.authorName} ${msg.cleanContent}`
        : `${prefixBlock}${location}${msg.authorName}: ${msg.cleanContent}`;

    // Advance trackers before forwarding: watermark (bounds future
    // backscroll), thread routing (publishes follow the conversation), and
    // the location-header context.
    this.forwardedWatermark.set(msg.roomId, msg.id);
    this.lastIncomingThread.set(msg.roomId, {
      // A message in a thread continues that thread; a top-level message that
      // gets a threaded reply roots a new one at itself.
      threadRootId: msg.threadRootId,
      lastEventId: msg.id,
    });
    this.lastRoomId = msg.roomId;

    const contentBlocks: ContentBlock[] = [textContent(renderedContent)];
    if (msg.attachments.length > 0) {
      contentBlocks.push(textContent(this.attachmentNote(msg.attachments)));
    }

    // MCPL RFC-001 event tags — reserved chat:* core, umbrellas included.
    // The host's wake gate routes on these.
    const eventTags: string[] = (() => {
      const t = new Set<string>();
      if (msg.mentionsBot) t.add('chat:mention');
      if (msg.isDM) { t.add('chat:dm'); t.add('chat:private'); }
      t.add(isAddressed ? 'chat:addressed' : 'chat:ambient');
      // Sibling agents sharing a room speak in m.text like anyone else, so
      // the sender class has to come from configuration, not the msgtype.
      t.add(msg.isPeerAgent ? 'chat:from-agent' : 'chat:from-human');
      if (msg.threadRootId) t.add('chat:thread');
      // @room is RFC-001's channel-wide ping; matrix:room-ping is kept as the
      // platform extension for gates that want to distinguish it.
      if (msg.pingsRoom) { t.add('chat:broadcast'); t.add('matrix:room-ping'); }
      for (const a of msg.attachments) {
        t.add(a.isImage ? 'chat:has-image' : 'chat:has-file');
      }
      return [...t];
    })();

    const metadata = {
      mentionIds: msg.mentionIds,
      mentioned: msg.mentionsBot,
      isMention: msg.mentionsBot,
      isDM: msg.isDM,
      threadRootId: msg.threadRootId,
      replyToId: msg.replyToId,
      pingsRoom: msg.pingsRoom,
      isPeerAgent: msg.isPeerAgent,
      msgtype: msg.msgtype,
      server: this.matrix.serverName,
      rawContent: msg.content,
      botUserId: this.matrix.userId,
      ...(msg.attachments.length > 0 ? { attachments: msg.attachments } : {}),
    };

    // If this channel is open, use channels/incoming; otherwise push/event
    if (channelIsOpen) {
      const incomingParams: ChannelsIncomingParams = {
        messages: [{
          channelId: channelMcplId,
          messageId: msg.id,
          threadId: msg.threadRootId,
          author: { id: msg.authorId, name: msg.authorName },
          timestamp: msg.timestamp.toISOString(),
          content: contentBlocks,
          metadata,
          tags: eventTags,
        }],
      };

      try {
        await conn.sendRequest(method.CHANNELS_INCOMING, incomingParams);
        dbg('handleMatrixMessage:sent', { method: 'channels/incoming', channelMcplId });
      } catch (err) {
        console.error('[matrix-mcpl] channels/incoming failed:', (err as Error).message);
      }
    } else {
      const pushParams: PushEventParams = {
        featureSet: 'matrix.messaging',
        eventId: `matrix_msg_${msg.roomId}_${msg.id}`,
        timestamp: msg.timestamp.toISOString(),
        origin: {
          source: 'matrix',
          messageId: msg.id,
          roomId: msg.roomId,
          threadRootId: msg.threadRootId,
          authorId: msg.authorId,
          authorName: msg.authorName,
          isMention: msg.mentionsBot,
          isDM: msg.isDM,
          server: this.matrix.serverName,
        } as Record<string, unknown>,
        tags: eventTags, // MCPL RFC-001 — the host routes/gates on these
        payload: { content: contentBlocks },
      };

      try {
        await conn.sendRequest(method.PUSH_EVENT, pushParams);
        dbg('handleMatrixMessage:sent', { method: 'push/event', channelMcplId });
      } catch (err) {
        console.error('[matrix-mcpl] push/event failed:', (err as Error).message);
      }
    }
  }
}
