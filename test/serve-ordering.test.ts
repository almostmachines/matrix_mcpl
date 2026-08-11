import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McplConnection } from '@animalabs/mcpl-core';

import { MatrixMcplServer } from '../src/server.js';
import type { MatrixAdapter } from '../src/matrix-adapter.js';

/**
 * Regression test for the startup deadlock that disabled the whole MCPL
 * surface in production.
 *
 * The server used to `await` the `channels/register` response before entering
 * its message loop. The host will not answer that until its own
 * `featureSets/update` Request has been answered — and that answer can only
 * come from the loop. Under MCPL 0.4 the grant was a Notification, so nothing
 * was waiting and the flaw was invisible; under 0.5 (agent-framework >=0.9)
 * it is a Request with a 15s timeout, after which the host logs
 * "did not answer the initial policy Request — MCPL privileged surface stays
 * disabled" and no message is ever delivered.
 *
 * The FakeConn below encodes exactly that host behaviour: `channels/register`
 * stays pending until the featureSets/update response is seen.
 */

interface SentRecord {
  kind: 'response' | 'request' | 'notification' | 'error';
  method?: string;
  id?: unknown;
  result?: unknown;
}

type Incoming =
  | { type: 'request'; request: { jsonrpc: '2.0'; id: number; method: string; params?: unknown } }
  | { type: 'notification'; notification: { jsonrpc: '2.0'; method: string; params?: unknown } };

class FakeConn {
  isClosed = false;
  sent: SentRecord[] = [];

  private queue: Incoming[] = [];
  private waiters: Array<(m: Incoming) => void> = [];
  private releaseRegister: (() => void) | null = null;

  /** True once the host's channels/register Request is outstanding. */
  registerOutstanding = false;

  constructor(private readonly holdRegistration = true) {}

  push(msg: Incoming): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(msg);
    else this.queue.push(msg);
  }

  nextMessage(): Promise<Incoming> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  sendRequest(method: string, params?: unknown): Promise<unknown> {
    this.sent.push({ kind: 'request', method, ...(params !== undefined ? {} : {}) });
    if (method === 'channels/register') {
      this.registerOutstanding = true;
      if (!this.holdRegistration) {
        this.registerOutstanding = false;
        return Promise.resolve({});
      }
      // The host is busy awaiting its own featureSets/update receipt, so it
      // does not answer this until that arrives.
      return new Promise<unknown>((resolve) => {
        this.releaseRegister = () => resolve({});
      });
    }
    return Promise.resolve({});
  }

  sendResponse(id: unknown, result: unknown): void {
    this.sent.push({ kind: 'response', id, result });
    // The host now unblocks the registration it was holding.
    if (this.releaseRegister) {
      this.releaseRegister();
      this.releaseRegister = null;
      this.registerOutstanding = false;
    }
  }

  sendNotification(method: string): void {
    this.sent.push({ kind: 'notification', method });
  }

  sendError(id: unknown, _code: number, message: string): void {
    this.sent.push({ kind: 'error', id, result: message });
  }

  close(): void {
    this.isClosed = true;
  }
}

interface FakeAdapterOptions {
  /** Optional gate used to keep fetchHistory genuinely in flight. */
  beforeFetchHistoryReturn?: () => Promise<void>;
}

function fakeAdapter(options: FakeAdapterOptions = {}): MatrixAdapter {
  return {
    serverName: 'example.org',
    userId: '@bot:example.org',
    displayName: 'Bot',
    onMessage() {},
    onRoomsChanged() {},
    async listRooms() {
      return [
        {
          roomId: '!room:example.org',
          kind: 'room' as const,
          name: 'General',
          encrypted: false,
        },
      ];
    },
    async resolveRoom(roomId: string) {
      return roomId;
    },
    async fetchHistory() {
      await options.beforeFetchHistoryReturn?.();
      return { messages: [], truncated: false };
    },
  } as unknown as MatrixAdapter;
}

/** Drive the handshake: initialize (MCPL mode) → initialized. */
function pushHandshake(conn: FakeConn): void {
  conn.push({
    type: 'request',
    request: {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        clientInfo: { name: 'test-host' },
        capabilities: { experimental: { mcpl: { version: '0.5' } } },
      },
    },
  });
  conn.push({ type: 'notification', notification: { jsonrpc: '2.0', method: 'notifications/initialized' } });
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

test('answers a Request-form featureSets/update while channels/register is still outstanding', async () => {
  const conn = new FakeConn();
  const server = new MatrixMcplServer(fakeAdapter());

  const served = server.serve(conn as unknown as McplConnection);

  pushHandshake(conn);
  // The host sends its policy Request while holding the registration open —
  // the exact sequence that deadlocked in production.
  conn.push({
    type: 'request',
    request: {
      jsonrpc: '2.0',
      id: 99,
      method: 'featureSets/update',
      params: { enabled: ['matrix.messaging', 'matrix.history', 'matrix.rooms'] },
    },
  });

  const answered = await waitFor(() =>
    conn.sent.some((s) => s.kind === 'response' && s.id === 99),
  );
  assert.ok(answered, 'featureSets/update was never answered — the loop is blocked on registration');

  const receipt = conn.sent.find((s) => s.kind === 'response' && s.id === 99)
    ?.result as { accepted?: boolean; mode?: string } | undefined;
  assert.equal(receipt?.accepted, true, 'receipt must accept the grant');
  assert.equal(receipt?.mode, 'full', 'all three feature sets were granted, so the mode is full');

  conn.close();
  conn.push({ type: 'notification', notification: { jsonrpc: '2.0', method: 'noop' } });
  await served;
});

test('a slow request handler does not stall replies to later requests', async () => {
  // Isolate request dispatch from the startup deadlock: registration resolves
  // immediately in this test, while fetchHistory is held on a controlled gate.
  // The old sequential loop would await the tools/call handler and never reach
  // the channels/list request until the gate was released.
  let historyStarted = false;
  let releaseHistory!: () => void;
  const historyGate = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });

  const conn = new FakeConn(false);
  const server = new MatrixMcplServer(fakeAdapter({
    beforeFetchHistoryReturn: async () => {
      historyStarted = true;
      await historyGate;
    },
  }));
  const served = server.serve(conn as unknown as McplConnection);

  try {
    pushHandshake(conn);
    assert.ok(
      await waitFor(() => conn.sent.some((s) => s.kind === 'response' && s.id === 0)),
      'initialize was not answered',
    );
    assert.ok(
      await waitFor(() => conn.sent.some((s) => s.kind === 'request' && s.method === 'channels/register')),
      'channels/register was not sent',
    );

    // tools/call for a tool that is guaranteed to remain in flight.
    conn.push({
      type: 'request',
      request: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'fetch_history', arguments: { roomId: '!room:example.org' } },
      },
    });
    assert.ok(
      await waitFor(() => historyStarted),
      'fetch_history never reached the controlled slow operation',
    );

    // A cheap protocol request queued behind the still-blocked tool call.
    conn.push({
      type: 'request',
      request: { jsonrpc: '2.0', id: 2, method: 'channels/list', params: {} },
    });

    const answered = await waitFor(() =>
      conn.sent.some((s) => s.kind === 'response' && s.id === 2),
    );
    assert.ok(answered, 'channels/list was not answered while a slower call was in flight');
    assert.ok(
      !conn.sent.some((s) => s.kind === 'response' && s.id === 1),
      'fetch_history unexpectedly completed before its gate was released',
    );
  } finally {
    releaseHistory();
    await waitFor(() => conn.sent.some((s) => s.kind === 'response' && s.id === 1));
    conn.close();
    conn.push({ type: 'notification', notification: { jsonrpc: '2.0', method: 'noop' } });
    await served;
  }
});
