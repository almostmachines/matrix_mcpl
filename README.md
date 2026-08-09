# matrix-mcpl

Standalone Matrix MCPL server: connects a Matrix account (rooms, DMs) to an
MCPL host as a first-class channel surface. Sibling of
[slack-mcpl](https://github.com/anima-research/slack-mcpl) and
[discord-mcpl](https://github.com/anima-research/discord-mcpl), built on
[`@animalabs/mcpl-core`](https://github.com/anima-research/mcpl-core-ts).

Works in plain MCP mode too (tools only, no push events or channels).

## Why Matrix fits

Matrix pushes events to an ordinary HTTP client over the `/sync` long-poll.
There is no webhook to expose and no second socket protocol to negotiate, so
this server runs spawned over stdio with no inbound network path — the property
Slack needs Socket Mode for and Discord needs a gateway for. Matrix also has
real typing notifications, first-class threads, and redaction, so
`channels/typing`, `threadId` and MCPL rollback all map onto native operations.

## Features

- **Channels**: every joined room is registered as an MCPL channel
  (`matrix:<roomId>`); `channels/publish` replies into the room's active thread
  automatically.
- **Real-time events** via `/sync` — no public webhook URL needed.
- **Addressing model**: mentions and DMs are always delivered; ambient room
  chatter flows only from subscribed rooms (auto-subscribe on first mention, opt
  out with `unsubscribe_room`). Events carry MCPL RFC-001 `chat:*` tags for
  host-side wake gating.
- **Mentions**: reads `m.mentions.user_ids` (intentional mentions, Matrix 1.7),
  falling back to `matrix.to` pills and then to the display name for older
  clients. An `@room` broadcast is deliberately *not* a personal mention — it
  tags `matrix:room-ping` and stays ambient.
- **Threads**: incoming `m.thread` replies carry `threadId`; `reply_message`
  posts into a thread by default, with `thread: false` for a rich reply.
- **Markdown both ways**: outgoing markdown is rendered into Matrix's
  `org.matrix.custom.html` subset (sanitized against an allowlist) with the
  plain text kept as `body`; incoming `formatted_body` is flattened back to
  text, with pills rendered as `@Name (mxid:@user:server)` so the agent can
  paste an ID straight into a tool call.
- **Attachments**: incoming media is forwarded as `mxc://` refs and fetched on
  demand via `fetch_attachment`, which resolves against the configured
  homeserver only and is size-capped at 5MB with a streaming budget.
- **Typing**: `channels/typing` drives real Matrix typing notifications, so
  humans see the agent thinking.
- **Rollback**: `matrix.messaging` supports MCPL checkpoints — rolling back
  redacts the events the bot sent after the checkpoint. Redacting your own
  events is always permitted, so this is reliable rather than best-effort
  (a redaction tombstone does remain visible).
- **Resumption**: with `MATRIX_STORAGE_FILE` set, the sync position persists, so
  messages sent while the server is down arrive on restart rather than being
  lost. On a genuine cold start the replayed timeline is dropped instead of
  flooding the agent with history.

## Tools

`send_message`, `reply_message`, `send_dm`, `add_reaction`, `edit_message`,
`delete_message`, `list_rooms`, `refresh_rooms`, `join_room`, `leave_room`,
`fetch_history`, `fetch_thread`, `find_user`, `fetch_attachment`,
`subscribe_room`, `unsubscribe_room`, `list_subscriptions`.

Feature sets: `matrix.messaging` (rollback-capable), `matrix.history`,
`matrix.rooms`.

## No end-to-end encryption

This server has no crypto. Rooms with `m.room.encryption` state are flagged
`encrypted: true` in their descriptor and in `list_rooms`, and a warning is
logged at startup — their messages arrive as undecryptable `m.room.encrypted`
events and are not forwarded.

**Use unencrypted rooms for the agent.** On your own homeserver this is a
per-room decision at creation time; note that Element defaults DMs and private
rooms to encrypted, so create the agent's rooms with encryption explicitly off.

Adding E2EE later means a persistent crypto store (matrix-bot-sdk's
`RustSdkCryptoStorageProvider`), device identity that must not be lost, and
history from before the bot joined staying unreadable — megolm keys are only
shared with devices present when a message was sent, so a device that joins
later never gets them. It is a bolt-on to the adapter, not a rewrite.

## History from before the bot joined

Unencrypted, this is a separate question from encryption and usually goes the
way you want. What the bot can read is set by the room's
`m.room.history_visibility` state:

| Value | The bot can read… |
|-------|-------------------|
| `world_readable` | everything, without even joining |
| `shared` | all history, including from before it joined (**assumed when the event is absent**) |
| `invited` | from the moment it was invited |
| `joined` | only from the moment it joined |

So in a typical room the agent joins and can immediately page back through the
whole timeline via `fetch_history`, and its first-interaction backscroll covers
conversation that predates it.

If the agent seems oddly amnesiac about anything before it arrived, check this
setting before suspecting the server — in Element it is Room Settings →
Security & Privacy → "Who can read history?".

## Setup

### 1. Create the bot account

Any normal Matrix account works — no app registration, no OAuth scopes. On your
own homeserver:

```bash
register_new_matrix_user -u connectome-agent -c /etc/matrix-synapse/homeserver.yaml
```

Or register through any client. Then set a display name, since it is what
humans will address the agent by.

### 2. Get an access token

```bash
curl -XPOST -d '{
  "type": "m.login.password",
  "identifier": { "type": "m.id.user", "user": "connectome-agent" },
  "password": "…",
  "initial_device_display_name": "matrix-mcpl"
}' 'https://matrix.example.org/_matrix/client/v3/login'
```

Take `access_token` from the response. It does not expire unless the device is
logged out, so keep it out of the recipe and pass it through the environment.

### 3. Invite the bot

Invite it to the rooms it should watch — it auto-accepts invites by default
(restrict this with `MATRIX_INVITE_ALLOWLIST`, or turn it off with
`MATRIX_AUTOJOIN=false` and use the `join_room` tool instead). DMs work without
any invite handling: anyone can open one, and `MATRIX_DM_USERS` whitelists who
gets through.

### 4. Run

```bash
npm install
npm run build

MATRIX_HOMESERVER_URL=https://matrix.example.org \
MATRIX_ACCESS_TOKEN=syt_… \
MATRIX_STORAGE_FILE=./matrix-mcpl-storage.json \
  matrix-mcpl --stdio
# or: matrix-mcpl --tcp 9041
```

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `MATRIX_HOMESERVER_URL` | yes | Base URL of the homeserver (`https://matrix.example.org`) |
| `MATRIX_ACCESS_TOKEN` | yes | Access token for the bot account |
| `MATRIX_DM_USERS` | no | Comma-separated MXID whitelist for DMs; others' DMs are dropped |
| `MATRIX_AUTOJOIN` | no | `false` to ignore room invites (default: accept) |
| `MATRIX_INVITE_ALLOWLIST` | no | Comma-separated MXIDs whose invites are accepted; all others declined |
| `MATRIX_STORAGE_FILE` | no | JSON file persisting the `/sync` token. **Strongly recommended** — without it every restart is a cold start and offline messages are lost |
| `MATRIX_SUBSCRIPTIONS_FILE` | no | JSON file persisting ambient subscriptions across restarts |
| `MATRIX_BACKSCROLL_LIMIT` | no | Messages fetched on first interaction with a room (default 50) |
| `MATRIX_ACCEPT_NOTICES` | no | `true` to deliver `m.notice` messages (default: dropped — they come from other bots, and forwarding them invites bot loops) |
| `MATRIX_PEER_AGENTS` | no | Comma-separated MXIDs of sibling agents; their messages are tagged `chat:from-agent` instead of `chat:from-human` |
| `MATRIX_MCPL_DEBUG_LOG` | no | Absolute path for a diagnostic file log |

## Running multiple agents

One process per agent, but only one installation — build once and point several
spawn configs at the same `dist/src/index.js` with different environments. The
adapter binds a single identity at connect time (one `whoami`, and self-filtering
and mention detection key off it), so there is no multi-account mode.

**These must differ per agent.** Sharing any of them silently breaks things:

| Variable | Why it cannot be shared |
|----------|-------------------------|
| `MATRIX_ACCESS_TOKEN` | One Matrix account per agent. Sharing one makes each agent's self-filter suppress the others' messages |
| `MATRIX_STORAGE_FILE` | Holds the sync token and filter ID for *one* account; two writers clobber each other's sync position |
| `MATRIX_SUBSCRIPTIONS_FILE` | Per-agent ambient room subscriptions |
| `--tcp <port>` | Only when using the TCP transport; stdio has no conflict |

Budget roughly one idle `/sync` long-poll and 50–80MB of Node per agent.
Separate accounts also help with rate limits, which Synapse buckets per user.

### Agents sharing a room

Sibling agents hear each other by default: the adapter filters only the agent's
*own* messages, and `send_message` sends `m.text` like any human client. Each
incoming message is rendered `Name: text` with the author in `metadata` and in
the `channels/incoming` `author` field, so an agent can see who spoke and decide
for itself whether to answer.

Two things to set up for this:

1. **Subscribe the shared room.** Ambient (non-mention) messages only flow from
   subscribed rooms. Mention the agent once in the room and it auto-subscribes
   permanently, or call `subscribe_room`, or pre-seed `MATRIX_SUBSCRIPTIONS_FILE`
   with the room ID. Note this is *not* the recipe's `channelSubscription`, which
   is a host-side concern — both matter, for different reasons.
2. **List the siblings** in `MATRIX_PEER_AGENTS` on each agent. Their messages
   are then tagged `chat:from-agent` rather than `chat:from-human`, which is what
   lets a wake policy treat "another agent said something" differently from "a
   person said something". Without it every sender looks human to the gate.

**On loops.** Judgement about when to stop is the primary control, and it is
usually enough — but two agents being polite at each other is a well-known way
to burn tokens overnight, and it does not need either one to be malfunctioning.
Two backstops sit under it:

- `chat:ambient` is throttled to one wake per 2 minutes and `chat:from-agent` to
  one per minute in this server's declared `defaultTreatment`; the host applies
  these unless a `gate.json` policy overrides them.
- If a specific pair does start ping-ponging, the cheapest fix is to have their
  inter-agent traffic use `send_message` with `notice: true` while leaving
  `MATRIX_ACCEPT_NOTICES` unset — they then cannot hear each other at all, while
  humans still see everything.

Worth watching the first few multi-agent sessions with `MATRIX_MCPL_DEBUG_LOG`
set before leaving them running unattended.

## Connectome recipe

Add to your recipe's `mcpServers` block (see `recipe-snippet.json`):

```json
"matrix": {
  "command": "node",
  "args": ["/absolute/path/to/matrix-mcpl/dist/src/index.js", "--stdio"],
  "env": {
    "MATRIX_HOMESERVER_URL": "https://matrix.example.org",
    "MATRIX_ACCESS_TOKEN": "${MATRIX_ACCESS_TOKEN}",
    "MATRIX_STORAGE_FILE": "./matrix-mcpl-storage.json",
    "MATRIX_SUBSCRIPTIONS_FILE": "./matrix-subscriptions.json"
  },
  "channelSubscription": ["matrix:!yourroom:example.org"]
}
```

Subscribing at the MCPL layer is only half of it — the host's wake policy
decides whether an arriving event triggers inference. Add a matching rule to
`_config/gate.json`:

```json
{
  "name": "matrix-main",
  "match": { "scope": ["mcpl:channel-incoming"], "channel": "matrix:!yourroom:example.org" },
  "behavior": "always"
}
```

## Development

```bash
npm run typecheck
npm test
```

The `content.ts` helpers are pure functions and carry the test suite; the
adapter and server layers are exercised against a live homeserver. To drive the
server by hand without running a full agent, point
[mcpl-harness](https://github.com/anima-research/mcpl-harness) at
`matrix-mcpl --tcp 9041`.

## Provenance

Structure follows `slack-mcpl` closely — the MCPL plumbing (channel
registration, feature-set gating, push/incoming routing, subscription
persistence, backscroll-on-first-interaction) is that server's design with
Matrix domain logic swapped in. Divergences are noted in comments where the
platforms genuinely differ.

Note: slack-mcpl logs two lines with `console.log` (client-initialized and
client-disconnected), which writes to the protocol channel in stdio mode. Those
are `console.error` here.
