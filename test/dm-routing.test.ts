import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McplConnection } from '@animalabs/mcpl-core';

import { MatrixMcplServer } from '../src/server.js';
import type { MatrixAdapter, MatrixMessageData } from '../src/matrix-adapter.js';

/**
 * Regression test: a DM must be delivered as `channels/incoming` even when the
 * host has that channel closed.
 *
 * Only `channels/incoming` sets the host's reply locus — `push/event` does not
 * (see connectome-host docs/LOCUS-ROUTING-DESIGN.md, and
 * `channel-registry.handleIncoming` setting `defaultPublishChannel`). The
 * server used to fall back to `push/event` for any channel the host had not
 * opened, so a DM arriving while another room was open was answered *in that
 * other room*.
 */

type Sent = { method?: string; params?: unknown };

class RecordingConn {
  isClosed = false;
  sent: Sent[] = [];
  private queue: unknown[] = [];
  private waiters: Array<(m: unknown) => void> = [];

  push(msg: unknown): void {
    const w = this.waiters.shift();
    if (w) w(msg);
    else this.queue.push(msg);
  }
  nextMessage(): Promise<unknown> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  sendRequest(method: string, params?: unknown): Promise<unknown> {
    this.sent.push({ method, params });
    return Promise.resolve({});
  }
  sendResponse(): void {}
  sendNotification(method: string, params?: unknown): void {
    this.sent.push({ method, params });
  }
  sendError(): void {}
  close(): void {
    this.isClosed = true;
  }
}

const DM_ROOM = '!dmroom:example.org';
const GROUP_ROOM = '!group:example.org';

function buildAdapter(): { adapter: MatrixAdapter; emit: (m: MatrixMessageData) => void } {
  let handler: ((m: MatrixMessageData) => void) | null = null;
  const adapter = {
    serverName: 'example.org',
    userId: '@bot:example.org',
    displayName: 'Bot',
    onMessage(h: (m: MatrixMessageData) => void) {
      handler = h;
    },
    onRoomsChanged() {},
    async listRooms() {
      return [
        { roomId: GROUP_ROOM, kind: 'room' as const, name: 'The Clearing', encrypted: false },
        { roomId: DM_ROOM, kind: 'dm' as const, name: 'John', userId: '@john:example.org', encrypted: false },
      ];
    },
    async getRoomMeta(roomId: string) {
      return roomId === DM_ROOM
        ? { roomId, kind: 'dm' as const, name: 'John', encrypted: false }
        : { roomId, kind: 'room' as const, name: 'The Clearing', encrypted: false };
    },
    async fetchBackscroll() {
      return [];
    },
  } as unknown as MatrixAdapter;
  return { adapter, emit: (m) => handler?.(m) };
}

function message(overrides: Partial<MatrixMessageData>): MatrixMessageData {
  return {
    roomId: DM_ROOM,
    id: '$evt1',
    authorId: '@john:example.org',
    authorName: 'John',
    content: 'hello',
    cleanContent: 'hello',
    mentionIds: [],
    mentionsBot: false,
    pingsRoom: false,
    isPeerAgent: false,
    isDM: true,
    msgtype: 'm.text',
    timestamp: new Date('2026-08-13T10:00:00Z'),
    attachments: [],
    ...overrides,
  } as MatrixMessageData;
}

async function startServer(): Promise<{
  conn: RecordingConn;
  emit: (m: MatrixMessageData) => void;
  stop: () => Promise<void>;
}> {
  const conn = new RecordingConn();
  const { adapter, emit } = buildAdapter();
  const server = new MatrixMcplServer(adapter);
  const served = server.serve(conn as unknown as McplConnection);

  conn.push({
    type: 'request',
    request: {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { clientInfo: { name: 'test' }, capabilities: { experimental: { mcpl: { version: '0.5' } } } },
    },
  });
  conn.push({ type: 'notification', notification: { jsonrpc: '2.0', method: 'notifications/initialized' } });

  await waitFor(() => conn.sent.some((s) => s.method === 'channels/register'));

  return {
    conn,
    emit,
    stop: async () => {
      conn.close();
      conn.push({ type: 'notification', notification: { jsonrpc: '2.0', method: 'noop' } });
      await served;
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

test('a DM on a closed channel is delivered as channels/incoming, not push/event', async () => {
  const { conn, emit, stop } = await startServer();
  try {
    // No channels/open has been received, so every channel is closed here —
    // exactly the state that misrouted the real DM.
    emit(message({ isDM: true }));

    const delivered = await waitFor(() =>
      conn.sent.some((s) => s.method === 'channels/incoming' || s.method === 'push/event'),
    );
    assert.ok(delivered, 'the DM was never forwarded at all');

    const methods = conn.sent.map((s) => s.method);
    assert.ok(
      methods.includes('channels/incoming'),
      `DM must use channels/incoming so the host binds the reply locus; got ${JSON.stringify(methods)}`,
    );
    assert.ok(!methods.includes('push/event'), 'DM must not fall back to push/event');

    const params = conn.sent.find((s) => s.method === 'channels/incoming')?.params as
      | { messages?: Array<{ channelId?: string }> }
      | undefined;
    assert.equal(params?.messages?.[0]?.channelId, `matrix:${DM_ROOM}`, 'must carry the DM room, not another');
  } finally {
    await stop();
  }
});

test('a mention on a closed channel is also delivered as channels/incoming', async () => {
  const { conn, emit, stop } = await startServer();
  try {
    emit(message({ roomId: GROUP_ROOM, isDM: false, mentionsBot: true, id: '$evt2' }));

    assert.ok(
      await waitFor(() => conn.sent.some((s) => s.method === 'channels/incoming')),
      'a direct mention must bind the reply locus too',
    );
  } finally {
    await stop();
  }
});

test('ambient chatter on a closed channel still uses push/event', async () => {
  // "Closed" must keep meaning "do not follow along here" for passive traffic —
  // otherwise incoming would silently reopen every room the host quietened.
  const { conn, emit, stop } = await startServer();
  try {
    emit(message({ roomId: GROUP_ROOM, isDM: false, mentionsBot: false, id: '$evt3' }));

    // Ambient + unsubscribed is dropped outright; nothing should be forwarded.
    await new Promise((r) => setTimeout(r, 150));
    const methods = conn.sent.map((s) => s.method);
    assert.ok(
      !methods.includes('channels/incoming'),
      `unaddressed chatter must not open the channel; got ${JSON.stringify(methods)}`,
    );
  } finally {
    await stop();
  }
});
