import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRoomTree } from '../src/discovery.js';
import type { PublicRoomInfo } from '../src/matrix-adapter.js';

const room = (id: string, extra: Partial<PublicRoomInfo> = {}): PublicRoomInfo => ({
  roomId: id,
  name: id.replace(/^!|:.*$/g, ''),
  isSpace: false,
  ...extra,
});
const space = (id: string, children: string[], extra: Partial<PublicRoomInfo> = {}): PublicRoomInfo => ({
  ...room(id, extra),
  isSpace: true,
  children,
});

test('rooms in a space are nested under it, not listed alongside', () => {
  // The real shape on reason: a "Topics" space containing three rooms.
  const topics = space('!topics:s', ['!tech:s', '!art:s', '!sci:s'], { name: 'Topics' });
  const directory = [topics, room('!tech:s'), room('!art:s'), room('!sci:s'), room('!commons:s')];
  const hierarchies = [[topics, room('!tech:s'), room('!art:s'), room('!sci:s')]];

  const tree = buildRoomTree(directory, hierarchies, new Set(['!commons:s']));

  assert.equal(tree.spaces.length, 1);
  assert.equal(tree.spaces[0].spaceId, '!topics:s');
  assert.deepEqual(tree.spaces[0].rooms.map((r) => r.roomId), ['!tech:s', '!art:s', '!sci:s']);
  // The grouped rooms must not also appear at the top level.
  assert.deepEqual(tree.ungroupedRooms.map((r) => r.roomId), ['!commons:s']);
});

test('joined state is reported per room, and spaces are excluded from the joinable count', () => {
  const topics = space('!topics:s', ['!tech:s', '!art:s']);
  const tree = buildRoomTree(
    [topics, room('!tech:s'), room('!art:s')],
    [[topics, room('!tech:s'), room('!art:s')]],
    new Set(['!tech:s']),
  );

  const rooms = tree.spaces[0].rooms;
  assert.equal(rooms.find((r) => r.roomId === '!tech:s')?.joined, true);
  assert.equal(rooms.find((r) => r.roomId === '!art:s')?.joined, false);
  // Only !art:s is joinable — the space itself is never counted, since
  // joining it would deliver nothing.
  assert.equal(tree.joinable, 1);
});

test('a room a space knows about but the directory never published still appears', () => {
  // Unpublished rooms are exactly why the hierarchy is merged in.
  const topics = space('!topics:s', ['!secret:s']);
  const tree = buildRoomTree([topics], [[topics, room('!secret:s')]], new Set());

  assert.deepEqual(tree.spaces[0].rooms.map((r) => r.roomId), ['!secret:s']);
  assert.equal(tree.joinable, 1);
});

test('nested spaces render inside their parent, not twice at the root', () => {
  const outer = space('!outer:s', ['!inner:s', '!a:s']);
  const inner = space('!inner:s', ['!b:s']);
  const tree = buildRoomTree(
    [outer, inner, room('!a:s'), room('!b:s')],
    [[outer, inner, room('!a:s')], [inner, room('!b:s')]],
    new Set(),
  );

  assert.deepEqual(tree.spaces.map((s) => s.spaceId), ['!outer:s'], 'inner space must not be a root');
  assert.deepEqual(tree.spaces[0].rooms.map((r) => r.roomId), ['!a:s']);
  assert.deepEqual(tree.spaces[0].spaces?.map((s) => s.spaceId), ['!inner:s']);
  assert.deepEqual(tree.spaces[0].spaces?.[0].rooms.map((r) => r.roomId), ['!b:s']);
});

test('a room listed by two spaces is rendered once', () => {
  const a = space('!a:s', ['!shared:s']);
  const b = space('!b:s', ['!shared:s']);
  const tree = buildRoomTree(
    [a, b, room('!shared:s')],
    [[a, room('!shared:s')], [b, room('!shared:s')]],
    new Set(),
  );

  const appearances = tree.spaces.flatMap((s) => s.rooms.filter((r) => r.roomId === '!shared:s'));
  assert.equal(appearances.length, 1, 'a shared room must not be duplicated across spaces');
  assert.equal(tree.ungroupedRooms.length, 0);
});

test('a cyclic space graph terminates', () => {
  // m.space.child permits cycles; recursion must not follow one forever.
  const a = space('!a:s', ['!b:s']);
  const b = space('!b:s', ['!a:s']);
  const tree = buildRoomTree([a, b], [[a, b], [b, a]], new Set());
  assert.ok(Array.isArray(tree.spaces), 'must return rather than overflow the stack');
});

test('with no spaces at all, every room is ungrouped', () => {
  const tree = buildRoomTree([room('!x:s'), room('!y:s')], [], new Set(['!x:s']));
  assert.equal(tree.spaces.length, 0);
  assert.deepEqual(tree.ungroupedRooms.map((r) => r.roomId), ['!x:s', '!y:s']);
  assert.equal(tree.joinable, 1);
});
