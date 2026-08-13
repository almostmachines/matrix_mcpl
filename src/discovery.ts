/**
 * Room discovery — assembling the published directory and space hierarchies
 * into something an agent can act on.
 *
 * Spaces are rendered as containers holding their rooms, never as joinable
 * entries: a space is an organisational grouping, not a conversation. Joining
 * one delivers nothing and does not join its children, so presenting it
 * alongside real rooms would invite exactly that mistake.
 */

import type { PublicRoomInfo } from './matrix-adapter.js';

export interface RenderedRoom {
  roomId: string;
  name?: string;
  alias?: string;
  topic?: string;
  memberCount?: number;
  joined: boolean;
}

export interface RenderedSpace {
  spaceId: string;
  name?: string;
  alias?: string;
  topic?: string;
  rooms: RenderedRoom[];
  spaces?: RenderedSpace[];
}

export interface RoomTree {
  spaces: RenderedSpace[];
  ungroupedRooms: RenderedRoom[];
  joinable: number;
}

/**
 * Build the discovery tree.
 *
 * `directory` is the published room directory; `hierarchies` are the flattened
 * subtrees returned per space, whose entries carry `children`. Both are needed:
 * the directory misses rooms a space knows about but that were never published,
 * and a hierarchy covers only one space's subtree.
 */
export function buildRoomTree(
  directory: PublicRoomInfo[],
  hierarchies: PublicRoomInfo[][],
  joined: Set<string>,
): RoomTree {
  const byId = new Map<string, PublicRoomInfo>();
  for (const r of directory) if (r.roomId) byId.set(r.roomId, r);

  const childOf = new Map<string, string>();
  for (const subtree of hierarchies) {
    for (const entry of subtree) {
      if (!entry.roomId) continue;
      const known = byId.get(entry.roomId);
      if (!known) {
        byId.set(entry.roomId, entry);
      } else if (entry.children?.length) {
        // Directory summaries are richer; keep them, take only the edges.
        known.children = entry.children;
      }
      for (const child of entry.children ?? []) {
        // First parent wins: a room listed by two spaces is rendered once,
        // rather than duplicated under both.
        if (!childOf.has(child)) childOf.set(child, entry.roomId);
      }
    }
  }

  const renderRoom = (r: PublicRoomInfo): RenderedRoom => ({
    roomId: r.roomId,
    ...(r.name ? { name: r.name } : {}),
    ...(r.alias ? { alias: r.alias } : {}),
    ...(r.topic ? { topic: r.topic } : {}),
    ...(r.memberCount !== undefined ? { memberCount: r.memberCount } : {}),
    joined: joined.has(r.roomId),
  });

  const renderSpace = (space: PublicRoomInfo, seen: Set<string>): RenderedSpace => {
    // Guard against a cyclic m.space.child graph, which the protocol permits.
    seen.add(space.roomId);
    const kids = (space.children ?? [])
      // Render a child only under its canonical parent. A room may be listed
      // by several spaces; without this it would appear under every one of
      // them, and the agent would think there are more rooms than there are.
      .filter((id) => !seen.has(id) && childOf.get(id) === space.roomId)
      .map((id) => byId.get(id))
      .filter((c): c is PublicRoomInfo => !!c);
    const childSpaces = kids.filter((c) => c.isSpace).map((c) => renderSpace(c, seen));
    return {
      spaceId: space.roomId,
      ...(space.name ? { name: space.name } : {}),
      ...(space.alias ? { alias: space.alias } : {}),
      ...(space.topic ? { topic: space.topic } : {}),
      rooms: kids.filter((c) => !c.isSpace).map(renderRoom),
      ...(childSpaces.length > 0 ? { spaces: childSpaces } : {}),
    };
  };

  const all = [...byId.values()].filter((r) => r.roomId);
  // Nested spaces are rendered inside their parent, not again at the root.
  const rootSpaces = all.filter((r) => r.isSpace && !childOf.has(r.roomId));
  const ungrouped = all.filter((r) => !r.isSpace && !childOf.has(r.roomId));

  return {
    spaces: rootSpaces.map((s) => renderSpace(s, new Set())),
    ungroupedRooms: ungrouped.map(renderRoom),
    joinable: all.filter((r) => !r.isSpace && !joined.has(r.roomId)).length,
  };
}
