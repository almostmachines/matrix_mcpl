/**
 * MatrixAdapter — owns the Matrix connection and all platform operations.
 *
 * Room IDs (!abc:example.org) are immutable and used for all routing; names
 * and aliases are mutable and only ever displayed.
 *
 * Connectivity: the client-server `/sync` long-poll. Matrix pushes events to a
 * plain HTTP client with no webhook and no separate socket protocol, so the
 * server works spawned over stdio with no inbound network path — the same
 * property Slack needs Socket Mode for.
 *
 * Threads map to `m.thread` relations: incoming replies carry their thread
 * root, and reply/publish routing posts into the thread of the referenced
 * message (top-level when the conversation isn't threaded).
 *
 * No end-to-end encryption. Rooms with `m.room.encryption` state are flagged
 * in their descriptor and logged at startup; their messages arrive as
 * undecryptable `m.room.encrypted` events and are not forwarded.
 */

import {
  MatrixClient,
  MatrixError,
  SimpleFsStorageProvider,
  type IStorageProvider,
} from 'matrix-bot-sdk';

import {
  classifyExtension,
  extractMentionedUserIds,
  markdownToMatrixHtml,
  matrixHtmlToText,
  mentionsUser,
  stripReplyFallback,
  type AttachmentRef,
} from './content.js';

/** Message types that represent real user content. Everything else
 *  (state changes, reactions, redactions) is noise for the inference loop. */
const CONTENT_MSGTYPES = new Set([
  'm.text', 'm.emote', 'm.notice', 'm.image', 'm.file', 'm.audio', 'm.video',
]);

const ATTACHMENT_MSGTYPES = new Set(['m.image', 'm.file', 'm.audio', 'm.video']);

export type RoomKind = 'room' | 'dm';

export interface MatrixRoomInfo {
  roomId: string;
  kind: RoomKind;
  /** Room name, or the DM counterpart's display name. */
  name: string;
  /** Canonical alias (#room:server), when the room publishes one. */
  alias?: string;
  /** DM counterpart user ID (dm only). */
  userId?: string;
  topic?: string;
  memberCount?: number;
  /** True when the room has m.room.encryption state — unreadable to this server. */
  encrypted: boolean;
}

export interface MatrixMessageData {
  roomId: string;
  /** Event ID ($…) — Matrix's message ID. */
  id: string;
  /** Thread root event ID, when this is an m.thread reply. */
  threadRootId?: string;
  /** Parent event ID, when this is a rich reply (m.in_reply_to). */
  replyToId?: string;
  authorId: string;
  authorName: string;
  /** Raw `body` as received. */
  content: string;
  /** formatted_body flattened to text, mentions rendered as @Name (mxid:…). */
  cleanContent: string;
  /** User IDs this message mentions. */
  mentionIds: string[];
  /** Personal mention of the bot — an @room ping doesn't count. */
  mentionsBot: boolean;
  /** True when the message carried `m.mentions.room` (the @room broadcast). */
  pingsRoom: boolean;
  /** True when the sender is a known sibling agent (MATRIX_PEER_AGENTS). */
  isPeerAgent: boolean;
  isDM: boolean;
  msgtype: string;
  timestamp: Date;
  attachments: AttachmentRef[];
}

export interface HistoryMessage {
  id: string;
  authorId?: string;
  authorName: string;
  content: string;
  threadRootId?: string;
  timestamp: Date;
  attachments: Array<{ name: string; mimeType?: string; url?: string }>;
}

export interface MatrixUserMatch {
  userId: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface MatrixAdapterConfig {
  homeserverUrl: string;
  accessToken: string;
  /** When set, DMs from anyone not in this user-ID list are dropped. */
  dmUsers?: string[];
  /** Auto-accept room invites (default true). */
  autojoin?: boolean;
  /** When set, only invites from these user IDs are auto-accepted. */
  inviteAllowlist?: string[];
  /** Path for the sync-token store. Without it, every restart is a cold start. */
  storagePath?: string;
  /** Deliver m.notice messages (default false — the convention is that
   *  notices come from other bots, and forwarding them invites bot loops). */
  acceptNotices?: boolean;
  /** MXIDs of sibling agents sharing rooms with this one. Their messages are
   *  tagged `chat:from-agent` rather than `chat:from-human` (RFC-001 §Sender),
   *  so the host can gate on who is speaking. */
  peerAgents?: string[];
}

/** Raw Matrix event as it comes off /sync or the history APIs. */
export interface RawMatrixEvent {
  type?: string;
  event_id?: string;
  sender?: string;
  origin_server_ts?: number;
  content?: Record<string, unknown>;
  unsigned?: Record<string, unknown>;
  state_key?: string;
}

/**
 * Connect to Matrix and build an adapter: `/account/whoami` resolves the bot's
 * own MXID (for self-filtering and mention detection) and its profile supplies
 * the display name, then the sync loop is prepared but not started — call
 * start() after registering the message handler.
 */
export async function connectMatrix(config: MatrixAdapterConfig): Promise<MatrixAdapter> {
  const storage: IStorageProvider | undefined = config.storagePath
    ? new SimpleFsStorageProvider(config.storagePath)
    : undefined;

  const client = new MatrixClient(config.homeserverUrl, config.accessToken, storage);
  const userId = await client.getUserId();

  let displayName: string | undefined;
  try {
    displayName = (await client.getUserProfile(userId))?.displayname;
  } catch {
    // Profile is optional — mention matching falls back to the localpart.
  }

  // A cold start (no persisted sync token) replays each room's recent
  // timeline. Those events are history, not news, so the adapter drops
  // anything older than this moment. When a token IS present the same events
  // are genuinely missed-while-offline and must be delivered.
  const coldStart = !(storage && (await Promise.resolve(storage.getSyncToken())));

  return new MatrixAdapter(client, userId, displayName, coldStart, config);
}

export class MatrixAdapter {
  private profileCache = new Map<string, string>();
  private roomCache = new Map<string, MatrixRoomInfo>();
  private messageHandlers: Array<(msg: MatrixMessageData) => void> = [];
  private roomsChangedHandlers: Array<(roomId: string) => void> = [];
  private started = false;
  /** Cold-start cutoff: events older than this are replayed history. */
  private readonly startedAt = Date.now();
  /** Rooms already warned about being encrypted, so the log stays readable. */
  private warnedEncrypted = new Set<string>();

  readonly serverName: string;

  constructor(
    private client: MatrixClient,
    readonly userId: string,
    readonly displayName: string | undefined,
    private readonly coldStart: boolean,
    private config: MatrixAdapterConfig,
  ) {
    this.serverName = userId.split(':').slice(1).join(':') || 'matrix';

    // Register handlers at construction so start() ordering can't race an
    // early event past an unregistered listener.
    this.client.on('room.message', (roomId: string, event: RawMatrixEvent) => {
      void this.handleMessageEvent(roomId, event).catch((error) => {
        console.error('[matrix-mcpl] Failed to handle Matrix message event:', error);
      });
    });

    this.client.on('room.invite', (roomId: string, event: RawMatrixEvent) => {
      void this.handleInvite(roomId, event).catch((error) => {
        console.error('[matrix-mcpl] Failed to handle invite:', error);
      });
    });

    // Room metadata is cached; drop the entry when the state behind it changes.
    this.client.on('room.event', (roomId: string, event: RawMatrixEvent) => {
      if (
        event?.type === 'm.room.name' ||
        event?.type === 'm.room.topic' ||
        event?.type === 'm.room.canonical_alias' ||
        event?.type === 'm.room.encryption'
      ) {
        this.roomCache.delete(roomId);
        for (const handler of this.roomsChangedHandlers) handler(roomId);
      }
    });

    // Without crypto the timeline of an encrypted room is opaque. Say so once
    // per room rather than failing silently.
    this.client.on('room.encrypted_event', (roomId: string) => {
      if (this.warnedEncrypted.has(roomId)) return;
      this.warnedEncrypted.add(roomId);
      console.error(
        `[matrix-mcpl] Room ${roomId} is end-to-end encrypted; this server has no crypto ` +
          `support, so its messages cannot be read. Use an unencrypted room for the agent.`,
      );
    });
  }

  onMessage(handler: (msg: MatrixMessageData) => void): void {
    this.messageHandlers.push(handler);
  }

  onRoomsChanged(handler: (roomId: string) => void): void {
    this.roomsChangedHandlers.push(handler);
  }

  /** Begin the /sync loop. Resolves once the first sync has been requested. */
  async start(): Promise<void> {
    if (this.started) return;
    // A filter would cut sync payloads down, but it also forces a re-sync from
    // scratch whenever it changes; the default is small enough for a bot.
    await this.client.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.started) {
      this.client.stop();
      this.started = false;
    }
  }

  // ── Rooms ──

  /** Every joined room, as channel-shaped metadata. Cached per room; the
   *  cache is dropped when the underlying state events change. */
  async listRooms(): Promise<MatrixRoomInfo[]> {
    const roomIds = await this.client.getJoinedRooms();
    const out: MatrixRoomInfo[] = [];
    // Each uncached room costs several state lookups; a bot in a few dozen
    // rooms would otherwise open a few hundred sockets at once.
    const CONCURRENCY = 5;
    for (let i = 0; i < roomIds.length; i += CONCURRENCY) {
      const batch = await Promise.all(
        roomIds.slice(i, i + CONCURRENCY).map((id) => this.describeRoom(id).catch(() => null)),
      );
      for (const info of batch) {
        // Spaces are not conversations — they hold rooms, not messages.
        if (info) out.push(info);
      }
    }
    return out;
  }

  async getRoomMeta(roomId: string): Promise<MatrixRoomInfo | null> {
    return this.describeRoom(roomId).catch(() => null);
  }

  /** Drop cached metadata for a room (used after joins and state changes). */
  invalidateRoom(roomId: string): void {
    this.roomCache.delete(roomId);
  }

  private async describeRoom(roomId: string): Promise<MatrixRoomInfo | null> {
    const cached = this.roomCache.get(roomId);
    if (cached) return cached;

    const [nameEv, topicEv, aliasEv, encryptionEv, createEv] = await Promise.all([
      this.roomState(roomId, 'm.room.name'),
      this.roomState(roomId, 'm.room.topic'),
      this.roomState(roomId, 'm.room.canonical_alias'),
      this.roomState(roomId, 'm.room.encryption'),
      this.roomState(roomId, 'm.room.create'),
    ]);

    // A space is a room whose create event says so; it holds child rooms, not
    // messages, so it is never a channel.
    if (createEv && createEv['type'] === 'm.space') return null;

    const isDm = this.client.dms.isDm(roomId);
    let members: string[] = [];
    try {
      members = await this.client.getJoinedRoomMembers(roomId);
    } catch {
      // Member list is best-effort — a name from state is enough without it.
    }
    const others = members.filter((m) => m !== this.userId);

    let name = (nameEv?.['name'] as string | undefined) ?? undefined;
    let counterpart: string | undefined;
    if (isDm || (!name && others.length === 1)) {
      counterpart = others[0];
      if (counterpart) {
        await this.resolveProfiles([counterpart]);
        name = this.profileCache.get(counterpart) ?? counterpart;
      }
    }

    const info: MatrixRoomInfo = {
      roomId,
      kind: isDm || (counterpart !== undefined && !nameEv?.['name']) ? 'dm' : 'room',
      name: name ?? (aliasEv?.['alias'] as string | undefined) ?? roomId,
      alias: (aliasEv?.['alias'] as string | undefined) ?? undefined,
      userId: counterpart,
      topic: (topicEv?.['topic'] as string | undefined) || undefined,
      memberCount: members.length || undefined,
      encrypted: encryptionEv !== null,
    };
    this.roomCache.set(roomId, info);
    return info;
  }

  /** Read a room state event, returning null when the room has none. */
  private async roomState(roomId: string, type: string): Promise<Record<string, unknown> | null> {
    try {
      return (await this.client.getRoomStateEvent(roomId, type, '')) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async resolveRoom(roomIdOrAlias: string): Promise<string> {
    if (roomIdOrAlias.startsWith('!')) return roomIdOrAlias;
    return await this.client.resolveRoom(roomIdOrAlias);
  }

  async joinRoom(roomIdOrAlias: string): Promise<string> {
    const roomId = await withRateLimitRetry(() => this.client.joinRoom(roomIdOrAlias));
    this.invalidateRoom(roomId);
    return roomId;
  }

  async leaveRoom(roomId: string): Promise<void> {
    await this.client.leaveRoom(roomId);
    this.roomCache.delete(roomId);
  }

  async setTyping(roomId: string, typing: boolean, timeoutMs = 20000): Promise<void> {
    await this.client.setTyping(roomId, typing, timeoutMs);
  }

  // ── Messaging ──

  /**
   * Send a message. The agent writes markdown; it goes out as `body` plus a
   * `formatted_body` in Matrix's HTML subset, so clients render it and
   * text-only consumers still get something readable.
   */
  async sendMessage(
    roomId: string,
    markdown: string,
    opts: { threadRootId?: string; replyToId?: string; notice?: boolean } = {},
  ): Promise<{ eventId: string }> {
    const content = this.buildMessageContent(markdown, opts);
    const eventId = await withRateLimitRetry(() => this.client.sendMessage(roomId, content));
    return { eventId };
  }

  private buildMessageContent(
    markdown: string,
    opts: { threadRootId?: string; replyToId?: string; notice?: boolean } = {},
  ): Record<string, unknown> {
    const html = markdownToMatrixHtml(markdown);
    const content: Record<string, unknown> = {
      msgtype: opts.notice ? 'm.notice' : 'm.text',
      body: markdown,
      ...(html ? { format: 'org.matrix.custom.html', formatted_body: html } : {}),
    };

    // Intentional mentions (Matrix 1.7): clients notify on these rather than
    // on a text match, so any MXID written into the body is declared here.
    const mentioned = [...markdown.matchAll(/@[a-z0-9._=\-/+]+:[a-z0-9.\-]+\.[a-z]{2,}/gi)]
      .map((m) => m[0]);
    if (mentioned.length > 0) {
      content['m.mentions'] = { user_ids: [...new Set(mentioned)] };
    }

    if (opts.threadRootId) {
      content['m.relates_to'] = {
        rel_type: 'm.thread',
        event_id: opts.threadRootId,
        // Clients that don't understand threads render this as a plain reply
        // to the latest message in the thread; is_falling_back says the
        // in_reply_to is scaffolding, not a real reply target.
        is_falling_back: true,
        'm.in_reply_to': { event_id: opts.replyToId ?? opts.threadRootId },
      };
    } else if (opts.replyToId) {
      content['m.relates_to'] = { 'm.in_reply_to': { event_id: opts.replyToId } };
    }

    return content;
  }

  /** Send a DM, reusing the m.direct room for that user when one exists. */
  async sendDM(userId: string, markdown: string): Promise<{ eventId: string; roomId: string }> {
    const roomId = await this.client.dms.getOrCreateDm(userId);
    this.invalidateRoom(roomId);
    const { eventId } = await this.sendMessage(roomId, markdown);
    return { eventId, roomId };
  }

  /** Edit a previously sent message via an m.replace relation. */
  async editMessage(roomId: string, eventId: string, markdown: string): Promise<void> {
    const inner = this.buildMessageContent(markdown);
    // The outer content is the fallback older clients show; m.new_content is
    // what edit-aware clients render in place of the original.
    const content: Record<string, unknown> = {
      ...inner,
      body: `* ${markdown}`,
      ...(inner.formatted_body ? { formatted_body: `* ${inner.formatted_body}` } : {}),
      'm.new_content': inner,
      'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
    };
    await withRateLimitRetry(() => this.client.sendMessage(roomId, content));
  }

  async redactEvent(roomId: string, eventId: string, reason?: string): Promise<void> {
    await withRateLimitRetry(() => this.client.redactEvent(roomId, eventId, reason ?? null));
  }

  async addReaction(roomId: string, eventId: string, key: string): Promise<void> {
    await withRateLimitRetry(() =>
      this.client.sendEvent(roomId, 'm.reaction', {
        'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key },
      }),
    );
  }

  // ── History ──

  /**
   * Room timeline, oldest-first. Unlike Slack, thread replies live in the main
   * timeline too, so this sees them; fetch_thread is for reading one thread
   * coherently rather than for reaching otherwise-invisible messages.
   */
  async fetchHistory(
    roomId: string,
    opts: { limit?: number; beforeEventId?: string } = {},
  ): Promise<{ messages: HistoryMessage[]; truncated: boolean }> {
    const limit = Math.min(opts.limit ?? 50, 1000);

    // /context gives the events immediately before a known event, which is
    // exactly what "page back from here" and first-interaction backscroll
    // need. Without an anchor, page backwards from the live end of the room.
    let events: RawMatrixEvent[];
    let truncated = false;
    if (opts.beforeEventId) {
      const ctx = (await this.client.doRequest(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/context/${encodeURIComponent(opts.beforeEventId)}`,
        { limit: limit * 2 },
      )) as { events_before?: RawMatrixEvent[] };
      // events_before comes newest-first.
      const before = (ctx.events_before ?? []).filter(isDisplayableMessage);
      truncated = before.length > limit;
      events = before.slice(0, limit).reverse();
    } else {
      const res = (await this.client.doRequest(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`,
        { dir: 'b', limit: limit * 2 },
      )) as { chunk?: RawMatrixEvent[] };
      const chunk = (res.chunk ?? []).filter(isDisplayableMessage);
      truncated = chunk.length > limit;
      events = chunk.slice(0, limit).reverse();
    }

    return { messages: await this.shapeHistory(events), truncated };
  }

  /** Every event in a thread, oldest-first, with the thread root first. */
  async fetchThread(
    roomId: string,
    threadRootId: string,
    limit = 100,
  ): Promise<{ messages: HistoryMessage[]; truncated: boolean }> {
    const collected: RawMatrixEvent[] = [];
    let from: string | undefined;
    let truncated = false;

    do {
      const res = (await this.client.doRequest(
        'GET',
        `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(threadRootId)}/m.thread`,
        { dir: 'f', limit: Math.min(100, limit - collected.length), ...(from ? { from } : {}) },
      )) as { chunk?: RawMatrixEvent[]; next_batch?: string };
      collected.push(...(res.chunk ?? []).filter(isDisplayableMessage));
      from = res.next_batch;
      if (from && collected.length >= limit) {
        truncated = true;
        from = undefined;
      }
    } while (from);

    // The relations endpoint returns replies only — prepend the root itself.
    let root: RawMatrixEvent | null = null;
    try {
      root = (await this.client.getEvent(roomId, threadRootId)) as RawMatrixEvent;
    } catch {
      // Root may be redacted or out of scope; the replies still stand alone.
    }

    const events = root ? [root, ...collected] : collected;
    return { messages: await this.shapeHistory(events), truncated };
  }

  /** The messages immediately preceding an event — first-interaction backscroll. */
  async fetchBackscroll(roomId: string, beforeEventId: string, limit: number): Promise<HistoryMessage[]> {
    const { messages } = await this.fetchHistory(roomId, { limit, beforeEventId });
    return messages;
  }

  private async shapeHistory(events: RawMatrixEvent[]): Promise<HistoryMessage[]> {
    await this.resolveProfiles(events.map((e) => e.sender).filter((s): s is string => !!s));

    return events.map((event) => {
      const content = (event.content ?? {}) as Record<string, unknown>;
      const relates = content['m.relates_to'] as Record<string, unknown> | undefined;
      const attachment = attachmentFrom(content);
      return {
        id: event.event_id ?? '',
        authorId: event.sender,
        authorName: event.sender ? (this.profileCache.get(event.sender) ?? event.sender) : 'unknown',
        content: renderContent(content),
        threadRootId:
          relates?.['rel_type'] === 'm.thread' ? (relates['event_id'] as string) : undefined,
        timestamp: new Date(event.origin_server_ts ?? 0),
        attachments: attachment
          ? [{ name: attachment.name, mimeType: attachment.mimeType, url: attachment.path }]
          : [],
      };
    });
  }

  // ── Users ──

  async findUsers(query: string, max = 25): Promise<MatrixUserMatch[]> {
    if (!query) throw new Error('query is required');
    const res = (await this.client.doRequest(
      'POST',
      '/_matrix/client/v3/user_directory/search',
      null,
      { search_term: query, limit: max },
    )) as { results?: Array<{ user_id?: string; display_name?: string; avatar_url?: string }> };

    return (res.results ?? [])
      .filter((r) => !!r.user_id && r.user_id !== this.userId)
      .map((r) => ({
        userId: r.user_id as string,
        displayName: r.display_name,
        avatarUrl: r.avatar_url,
      }));
  }

  /** Resolve MXIDs to display names into the adapter's cache, memoized for its
   *  lifetime. Failures leave the raw MXID in place (best-effort). */
  private async resolveProfiles(userIds: Array<string | undefined>): Promise<void> {
    const unresolved = [
      ...new Set(userIds.filter((id): id is string => !!id && !this.profileCache.has(id))),
    ];
    // Chunked, not one big Promise.all — a busy room can reference dozens of
    // distinct users, and an unbounded profile fan-out just queues up 429s.
    const CONCURRENCY = 8;
    for (let i = 0; i < unresolved.length; i += CONCURRENCY) {
      await Promise.all(
        unresolved.slice(i, i + CONCURRENCY).map(async (id) => {
          try {
            const profile = await this.client.getUserProfile(id);
            this.profileCache.set(id, (profile?.displayname as string) || id);
          } catch {
            this.profileCache.set(id, id);
          }
        }),
      );
    }
  }

  // ── Media ──

  /** The base URL media downloads go to. The access token is only ever sent
   *  here — media is addressed by mxc:// URI, never by attacker-chosen URL. */
  get homeserverUrl(): string {
    return this.config.homeserverUrl;
  }

  get accessToken(): string {
    return this.config.accessToken;
  }

  // ── Incoming events ──

  private async handleInvite(roomId: string, event: RawMatrixEvent): Promise<void> {
    if (this.config.autojoin === false) {
      console.error(`[matrix-mcpl] Ignoring invite to ${roomId} (autojoin disabled)`);
      return;
    }
    const inviter = event.sender;
    const allowlist = this.config.inviteAllowlist;
    if (allowlist && allowlist.length > 0 && (!inviter || !allowlist.includes(inviter))) {
      console.error(`[matrix-mcpl] Declining invite to ${roomId} from ${inviter} (not on MATRIX_INVITE_ALLOWLIST)`);
      await this.client.leaveRoom(roomId).catch(() => {});
      return;
    }

    try {
      await withRateLimitRetry(() => this.client.joinRoom(roomId));
      this.invalidateRoom(roomId);
      console.error(`[matrix-mcpl] Joined ${roomId} on invite from ${inviter}`);
      for (const handler of this.roomsChangedHandlers) handler(roomId);
    } catch (err) {
      console.error(`[matrix-mcpl] Failed to join ${roomId}:`, (err as Error).message);
    }
  }

  private async handleMessageEvent(roomId: string, event: RawMatrixEvent): Promise<void> {
    if (!event || event.type !== 'm.room.message') return;
    const content = (event.content ?? {}) as Record<string, unknown>;
    const msgtype = typeof content.msgtype === 'string' ? content.msgtype : '';
    if (!CONTENT_MSGTYPES.has(msgtype)) return;

    // Self-filter: never react to our own messages.
    if (event.sender === this.userId) return;

    // m.notice is the convention for automated senders. Forwarding it is how
    // two bots in one room talk each other into an infinite loop.
    if (msgtype === 'm.notice' && !this.config.acceptNotices) return;

    // A real content message always carries sender, event_id and a timestamp;
    // a malformed payload missing any of them is dropped, not crashed on.
    if (!event.sender || !event.event_id || typeof event.origin_server_ts !== 'number') return;

    // Edits arrive as ordinary messages carrying m.replace. The original is
    // already in the agent's context, so forwarding the edit would duplicate
    // the turn — slack-mcpl drops message_changed for the same reason.
    const relates = content['m.relates_to'] as Record<string, unknown> | undefined;
    if (relates?.['rel_type'] === 'm.replace') return;

    // Cold start replays each room's recent timeline; that's history, not news.
    if (this.coldStart && event.origin_server_ts < this.startedAt) return;

    const isDM = this.client.dms.isDm(roomId);
    if (isDM && this.config.dmUsers && this.config.dmUsers.length > 0 && !this.config.dmUsers.includes(event.sender)) {
      return; // DM whitelist active and this sender isn't on it
    }

    const mentionIds = extractMentionedUserIds(content);
    await this.resolveProfiles([event.sender, ...mentionIds]);
    const authorName = this.profileCache.get(event.sender) ?? event.sender;

    const attachment = attachmentFrom(content);
    const mentions = content['m.mentions'] as { room?: unknown } | undefined;

    const threadRootId =
      relates?.['rel_type'] === 'm.thread' ? (relates['event_id'] as string) : undefined;
    const inReplyTo = relates?.['m.in_reply_to'] as { event_id?: string } | undefined;

    const msg: MatrixMessageData = {
      roomId,
      id: event.event_id,
      threadRootId,
      // Inside a thread the in_reply_to is scaffolding for old clients, not a
      // reply the agent should treat as one.
      replyToId: threadRootId ? undefined : inReplyTo?.event_id,
      authorId: event.sender,
      authorName,
      content: typeof content.body === 'string' ? content.body : '',
      cleanContent: renderContent(content),
      mentionIds,
      // Personal mention of the bot — hosts use this to gate wake policy.
      // The @room broadcast deliberately doesn't count.
      mentionsBot: mentionsUser(content, this.userId, this.displayName),
      pingsRoom: mentions?.room === true,
      isPeerAgent: this.config.peerAgents?.includes(event.sender) ?? false,
      isDM,
      msgtype,
      timestamp: new Date(event.origin_server_ts),
      attachments: attachment ? [attachment] : [],
    };

    for (const handler of this.messageHandlers) handler(msg);
  }
}

// ── Free functions ──

/** True for events worth showing the agent in a history listing. */
function isDisplayableMessage(event: RawMatrixEvent): boolean {
  if (event?.type !== 'm.room.message') return false;
  const content = (event.content ?? {}) as Record<string, unknown>;
  // A redacted event keeps its type but loses its content.
  if (!content.body) return false;
  const relates = content['m.relates_to'] as Record<string, unknown> | undefined;
  if (relates?.['rel_type'] === 'm.replace') return false;
  return CONTENT_MSGTYPES.has(typeof content.msgtype === 'string' ? content.msgtype : '');
}

/** Flatten a message content block to the text the agent reads. */
function renderContent(content: Record<string, unknown>): string {
  const body = typeof content.body === 'string' ? content.body : '';
  if (content.format === 'org.matrix.custom.html' && typeof content.formatted_body === 'string') {
    const text = matrixHtmlToText(content.formatted_body);
    if (text) return text;
  }
  return stripReplyFallback(body);
}

/** The attachment an m.image/m.file/m.audio/m.video message carries, if any. */
function attachmentFrom(content: Record<string, unknown>): AttachmentRef | null {
  const msgtype = typeof content.msgtype === 'string' ? content.msgtype : '';
  if (!ATTACHMENT_MSGTYPES.has(msgtype)) return null;

  // `file` (rather than `url`) means the media is encrypted; without crypto
  // the bytes would decode to noise, so it is deliberately not offered.
  const url = typeof content.url === 'string' ? content.url : undefined;
  if (!url) return null;

  const name = typeof content.body === 'string' && content.body ? content.body : 'attachment';
  const info = (content.info ?? {}) as Record<string, unknown>;
  const mimeType =
    (typeof info.mimetype === 'string' ? info.mimetype : undefined) || classifyExtension(name).mimeType;

  return {
    path: url,
    name,
    mimeType,
    isImage: msgtype === 'm.image' || mimeType.startsWith('image/'),
    size: typeof info.size === 'number' ? info.size : undefined,
  };
}

/**
 * Retry a request once per rate-limit response. Matrix answers a flood with
 * `M_LIMIT_EXCEEDED` and an exact `retry_after_ms`; matrix-bot-sdk surfaces it
 * but doesn't act on it, so an agent posting a burst would drop messages.
 */
async function withRateLimitRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const retryAfter =
        err instanceof MatrixError && err.errcode === 'M_LIMIT_EXCEEDED'
          ? (err.retryAfterMs ?? 1000)
          : null;
      if (retryAfter === null || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 30000)));
    }
  }
  throw lastError;
}
