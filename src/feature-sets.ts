/**
 * Feature set declarations for the Matrix MCPL server.
 */

import type { FeatureSetDeclaration } from '@animalabs/mcpl-core';

export const featureSets: FeatureSetDeclaration[] = [
  {
    name: 'matrix.messaging',
    description: 'Send, read, react to messages in Matrix rooms',
    uses: ['tools', 'channels.publish'],
    rollback: true,
    hostState: false,
    // MCPL RFC-001 — tags carried on Matrix message events (emits umbrellas
    // directly, so no host-side implication expansion is needed).
    tagOntology: {
      coreTags: [
        'chat:addressed', 'chat:mention', 'chat:dm', 'chat:ambient',
        'chat:private', 'chat:from-human', 'chat:thread',
        'chat:has-image', 'chat:has-file',
      ],
      defaultTreatment: [
        { tagsAny: ['chat:addressed'], behavior: 'immediate' },
        { tagsAny: ['chat:ambient'], behavior: { throttle: { perMs: 120000 } } },
      ],
      // Matrix-specific extensions (e.g. matrix:room-ping for @room) may be
      // emitted; consumers should tolerate undeclared tags.
      open: true,
    },
  },
  {
    name: 'matrix.history',
    description: 'Fetch message and thread history from Matrix rooms',
    uses: ['tools'],
    rollback: false,
    hostState: false,
  },
  {
    name: 'matrix.rooms',
    description:
      'Join rooms by ID or alias, and manage per-room ambient-message subscriptions ' +
      '(which rooms deliver non-mention messages for passive awareness). Mentions and ' +
      'DMs are always delivered and are not affected by subscriptions.',
    uses: ['tools'],
    rollback: false,
    hostState: false,
  },
];

/** Check if a feature set is in a given enabled list. */
export function isEnabled(name: string, enabledSets: Set<string>): boolean {
  // Check exact match
  if (enabledSets.has(name)) return true;
  // Check wildcard (e.g., "matrix.*")
  const parts = name.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join('.') + '.*';
    if (enabledSets.has(prefix)) return true;
  }
  return false;
}

/** Get the feature set that owns a given tool. Returns undefined for always-available tools. */
export function featureSetForTool(toolName: string): string | undefined {
  switch (toolName) {
    case 'send_message':
    case 'reply_message':
    case 'send_dm':
    case 'add_reaction':
    case 'edit_message':
    case 'delete_message':
      return 'matrix.messaging';
    case 'fetch_history':
    case 'fetch_thread':
    case 'fetch_attachment':
      return 'matrix.history';
    case 'join_room':
    case 'leave_room':
    case 'subscribe_room':
    case 'unsubscribe_room':
    case 'list_subscriptions':
      return 'matrix.rooms';
    case 'list_rooms':
    case 'refresh_rooms':
    case 'find_user':
      return undefined; // Always available
    default:
      return undefined;
  }
}
