/**
 * MCPL channel management — maps Matrix rooms to MCPL ChannelDescriptors.
 */

import type { ChannelDescriptor } from '@animalabs/mcpl-core';
import type { MatrixRoomInfo } from './matrix-adapter.js';

/** MCPL channel ID format: `matrix:<roomId>`, e.g. `matrix:!abc:example.org`.
 *
 *  Room IDs are globally unique and immutable; names and aliases are neither,
 *  so routing never touches them. The ID contains colons of its own, hence the
 *  prefix-strip below rather than a split. */
export function mcplChannelId(roomId: string): string {
  return `matrix:${roomId}`;
}

/** Parse an MCPL channel ID back to a room ID. Returns null if not a matrix channel. */
export function parseMcplChannelId(id: string): { roomId: string } | null {
  if (!id.startsWith('matrix:')) return null;
  const roomId = id.slice('matrix:'.length);
  if (!roomId) return null;
  return { roomId };
}

/** Convert a Matrix room to an MCPL ChannelDescriptor. */
export function toDescriptor(room: MatrixRoomInfo, serverName: string): ChannelDescriptor {
  const label =
    room.kind === 'dm'
      ? `DM: ${room.name} (${serverName})`
      : `${room.alias ?? room.name} (${serverName})`;
  return {
    id: mcplChannelId(room.roomId),
    type: 'matrix',
    label,
    direction: 'bidirectional',
    address: { roomId: room.roomId, ...(room.userId ? { userId: room.userId } : {}) },
    metadata: {
      kind: room.kind,
      ...(room.alias ? { alias: room.alias } : {}),
      ...(room.topic ? { topic: room.topic } : {}),
      ...(room.memberCount !== undefined ? { memberCount: room.memberCount } : {}),
      // Surfaced so the host can see why a room is silent: this server has no
      // crypto, so an encrypted room's timeline arrives undecryptable.
      ...(room.encrypted ? { encrypted: true } : {}),
    },
  };
}

/**
 * Tracks which channels are registered (known to host) and which are open
 * (host has explicitly opened them for bidirectional message flow).
 */
export class ChannelManager {
  /** All registered channel descriptors, keyed by MCPL channel ID. */
  private registered = new Map<string, ChannelDescriptor>();

  /** Set of open channel IDs (subset of registered). */
  private openChannels = new Set<string>();

  registerAll(descriptors: ChannelDescriptor[]): void {
    for (const d of descriptors) {
      this.registered.set(d.id, d);
    }
  }

  register(descriptor: ChannelDescriptor): void {
    this.registered.set(descriptor.id, descriptor);
  }

  unregister(id: string): boolean {
    this.openChannels.delete(id);
    return this.registered.delete(id);
  }

  open(id: string): ChannelDescriptor | undefined {
    const desc = this.registered.get(id);
    if (desc) {
      this.openChannels.add(id);
    }
    return desc;
  }

  /** Open a channel by Matrix room ID. Returns the descriptor if found. */
  openByRoomId(roomId: string): ChannelDescriptor | undefined {
    return this.open(mcplChannelId(roomId));
  }

  close(id: string): boolean {
    return this.openChannels.delete(id);
  }

  isOpen(id: string): boolean {
    return this.openChannels.has(id);
  }

  get(id: string): ChannelDescriptor | undefined {
    return this.registered.get(id);
  }

  getAll(): ChannelDescriptor[] {
    return [...this.registered.values()];
  }

  getOpen(): ChannelDescriptor[] {
    return [...this.openChannels]
      .map((id) => this.registered.get(id))
      .filter((d): d is ChannelDescriptor => d !== undefined);
  }
}
