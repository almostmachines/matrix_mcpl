/**
 * MCP tool definitions and input types for Matrix operations.
 * These tools work in both MCP and MCPL mode.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'send_message',
    description:
      'Send a message to a Matrix room (or DM room). Write markdown — it is rendered to ' +
      'the HTML subset Matrix clients display, with the plain text kept as a fallback. ' +
      'To mention someone use their full MXID (@user:server); find_user resolves names to MXIDs.',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Matrix room ID (!abc:example.org) or alias (#room:example.org)' },
        content: { type: 'string', description: 'Message text (markdown)' },
        notice: {
          type: 'boolean',
          description:
            'Send as m.notice instead of m.text (default false). Notices are the convention ' +
            'for automated output and are ignored by other bots — use it for status/log messages, ' +
            'not for conversation.',
        },
      },
      required: ['roomId', 'content'],
    },
  },
  {
    name: 'reply_message',
    description:
      'Reply to a specific message. By default this posts into that message\'s thread ' +
      '(Matrix m.thread) — incoming thread replies carry the thread root as threadId. ' +
      'Set thread=false for a rich reply instead, which quotes the message inline without ' +
      'starting a thread.',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Matrix room ID' },
        eventId: { type: 'string', description: 'Event ID ($…) to reply to. In a thread, pass the thread root to keep the thread going.' },
        content: { type: 'string', description: 'Reply text (markdown)' },
        thread: { type: 'boolean', description: 'Post as a threaded reply (default true)' },
      },
      required: ['roomId', 'eventId', 'content'],
    },
  },
  {
    name: 'send_dm',
    description:
      'Send a direct message to a Matrix user. Reuses the existing DM room when there is ' +
      'one (per m.direct account data), otherwise creates an invite-only room with that ' +
      'user and marks it as a DM.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'Full Matrix user ID (@user:example.org)' },
        content: { type: 'string', description: 'Message text (markdown)' },
      },
      required: ['userId', 'content'],
    },
  },
  {
    name: 'add_reaction',
    description: 'Add an emoji reaction (m.reaction annotation) to a Matrix event',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Matrix room ID' },
        eventId: { type: 'string', description: 'Event ID ($…) to react to' },
        emoji: { type: 'string', description: 'The reaction key — a literal emoji such as 👍' },
      },
      required: ['roomId', 'eventId', 'emoji'],
    },
  },
  {
    name: 'edit_message',
    description:
      'Edit a message sent by this bot. Sends an m.replace relation; clients show the new ' +
      'text with an "(edited)" marker.',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Matrix room ID' },
        eventId: { type: 'string', description: 'Event ID ($…) to edit' },
        content: { type: 'string', description: 'New message text (markdown)' },
      },
      required: ['roomId', 'eventId', 'content'],
    },
  },
  {
    name: 'delete_message',
    description:
      'Redact (delete) an event. Always permitted for the bot\'s own messages; redacting ' +
      'someone else\'s needs moderator power in the room.',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Matrix room ID' },
        eventId: { type: 'string', description: 'Event ID ($…) to redact' },
        reason: { type: 'string', description: 'Optional reason, shown in the redaction tombstone' },
      },
      required: ['roomId', 'eventId'],
    },
  },
  {
    name: 'list_rooms',
    description:
      'List the Matrix rooms the bot has joined, with their IDs, aliases, topics and ' +
      'member counts. Rooms flagged encrypted:true cannot be read — this server has no ' +
      'end-to-end encryption support, so their messages arrive undecryptable.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'refresh_rooms',
    description:
      'Re-scan every joined room and register any the host does not yet know about. Use ' +
      'this if the bot was invited to a room after startup and it is not showing up in ' +
      'your channel list.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'join_room',
    description:
      'Join a Matrix room by ID or alias. The room must be public, or the bot must already ' +
      'hold an invite. The room is registered as a channel on success.',
    inputSchema: {
      type: 'object',
      properties: {
        roomIdOrAlias: { type: 'string', description: 'Room ID (!abc:example.org) or alias (#room:example.org)' },
      },
      required: ['roomIdOrAlias'],
    },
  },
  {
    name: 'leave_room',
    description: 'Leave a Matrix room and stop receiving its messages',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Matrix room ID to leave' },
      },
      required: ['roomId'],
    },
  },
  {
    name: 'fetch_history',
    description:
      'Fetch message history from a Matrix room, oldest-first. Unlike Slack, thread ' +
      'replies DO appear in the main timeline, so this covers them too — but fetch_thread ' +
      'is still the way to read one thread coherently. Pass beforeEventId to page backwards ' +
      'from a known event.',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Matrix room ID' },
        limit: { type: 'number', description: 'Max messages to fetch (default 50)' },
        beforeEventId: {
          type: 'string',
          description: 'Only fetch messages older than this event (exclusive). Use the oldest ID you already have to page back.',
        },
      },
      required: ['roomId'],
    },
  },
  {
    name: 'fetch_thread',
    description:
      'Fetch all replies in a Matrix thread, oldest-first (the thread root comes first). ' +
      'Use the thread root event ID — incoming thread replies carry it as threadId.',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Matrix room ID' },
        threadRootId: { type: 'string', description: 'Event ID ($…) of the thread root' },
        limit: { type: 'number', description: 'Max messages to fetch (default 100)' },
      },
      required: ['roomId', 'threadRootId'],
    },
  },
  {
    name: 'find_user',
    description:
      'Search the homeserver user directory by name. Returns MXIDs for mentions and DMs — ' +
      'put the full @user:server in message text to mention someone. The directory only ' +
      'covers users the bot shares a room with, plus anyone published in the public directory.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name fragment to search for (case-insensitive)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_attachment',
    description:
      'Fetch a Matrix media attachment by its mxc:// URI and return its bytes inline: ' +
      'images as image blocks, text-ish files decoded, other binary as base64. URIs come ' +
      'from incoming message attachment refs. Max 5MB.',
    inputSchema: {
      type: 'object',
      properties: {
        mxcUrl: { type: 'string', description: 'The mxc:// URI of the media (mxc://server/mediaId)' },
      },
      required: ['mxcUrl'],
    },
  },
  {
    name: 'subscribe_room',
    description:
      'Subscribe to ambient (non-mention) messages from a Matrix room. Direct mentions and ' +
      'DMs always come through regardless of subscriptions; this only controls passive ' +
      'awareness of room chatter. Persisted across restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Matrix room ID to subscribe to' },
      },
      required: ['roomId'],
    },
  },
  {
    name: 'unsubscribe_room',
    description:
      'Stop receiving ambient messages from a Matrix room. Mentions and DMs from there ' +
      'will still arrive. Persisted across restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Matrix room ID to unsubscribe from' },
      },
      required: ['roomId'],
    },
  },
  {
    name: 'list_subscriptions',
    description: 'List the Matrix rooms currently subscribed for ambient message delivery',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];
