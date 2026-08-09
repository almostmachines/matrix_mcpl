import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ChannelManager, mcplChannelId, parseMcplChannelId, toDescriptor } from '../src/channels.js';
import { StateTracker } from '../src/state.js';
import type { MatrixRoomInfo } from '../src/matrix-adapter.js';

const room: MatrixRoomInfo = {
  roomId: '!abc123:example.org',
  kind: 'room',
  name: 'General',
  alias: '#general:example.org',
  topic: 'Chat',
  memberCount: 4,
  encrypted: false,
};

test('channel IDs round-trip despite colons in the room ID', () => {
  // Room IDs contain their own colons — parsing must strip the prefix, not
  // split on the separator.
  const id = mcplChannelId(room.roomId);
  assert.equal(id, 'matrix:!abc123:example.org');
  assert.deepEqual(parseMcplChannelId(id), { roomId: '!abc123:example.org' });
});

test('parseMcplChannelId rejects other platforms and empty IDs', () => {
  assert.equal(parseMcplChannelId('slack:C123'), null);
  assert.equal(parseMcplChannelId('matrix:'), null);
});

test('toDescriptor labels rooms by alias and DMs by counterpart', () => {
  const d = toDescriptor(room, 'example.org');
  assert.equal(d.id, 'matrix:!abc123:example.org');
  assert.equal(d.type, 'matrix');
  assert.equal(d.label, '#general:example.org (example.org)');
  assert.deepEqual(d.address, { roomId: '!abc123:example.org' });
  // metadata is `unknown` on the wire type — narrow it for the assertion.
  assert.equal((d.metadata as Record<string, unknown>).topic, 'Chat');

  const dm = toDescriptor(
    { roomId: '!dm:example.org', kind: 'dm', name: 'Alice', userId: '@alice:example.org', encrypted: false },
    'example.org',
  );
  assert.equal(dm.label, 'DM: Alice (example.org)');
  assert.deepEqual(dm.address, { roomId: '!dm:example.org', userId: '@alice:example.org' });
});

test('toDescriptor flags encrypted rooms', () => {
  // The host needs to know why a joined room is silent.
  const d = toDescriptor({ ...room, encrypted: true }, 'example.org');
  assert.equal((d.metadata as Record<string, unknown>).encrypted, true);
});

test('ChannelManager tracks registered and open channels separately', () => {
  const mgr = new ChannelManager();
  const d = toDescriptor(room, 'example.org');
  mgr.register(d);

  assert.equal(mgr.isOpen(d.id), false);
  assert.equal(mgr.openByRoomId(room.roomId)?.id, d.id);
  assert.equal(mgr.isOpen(d.id), true);
  assert.deepEqual(mgr.getOpen().map((c) => c.id), [d.id]);

  assert.equal(mgr.close(d.id), true);
  assert.equal(mgr.isOpen(d.id), false);
  assert.equal(mgr.getAll().length, 1);

  assert.equal(mgr.unregister(d.id), true);
  assert.equal(mgr.getAll().length, 0);
});

test('ChannelManager will not open an unregistered channel', () => {
  const mgr = new ChannelManager();
  assert.equal(mgr.openByRoomId('!nope:example.org'), undefined);
  assert.equal(mgr.isOpen('matrix:!nope:example.org'), false);
});

test('StateTracker rolls back to the events sent after a checkpoint', () => {
  const st = new StateTracker();
  st.recordSent('$1', '!r:example.org', 'before');
  const cp = st.createCheckpoint();
  st.recordSent('$2', '!r:example.org', 'after one');
  st.recordSent('$3', '!r:example.org', 'after two');

  const toRedact = st.rollback(cp);
  assert.deepEqual(toRedact?.map((m) => m.messageId), ['$2', '$3']);
  // Rolling back again from the same checkpoint has nothing left to undo.
  assert.deepEqual(st.rollback(cp), []);
  assert.equal(st.rollback('chk_missing'), null);
});
