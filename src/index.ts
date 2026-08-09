#!/usr/bin/env node
/**
 * Matrix MCPL server — CLI entry point.
 *
 * Usage:
 *   matrix-mcpl --stdio           # MCP-compatible stdio transport
 *   matrix-mcpl --tcp <port>      # TCP transport for MCPL hosts
 *
 * Environment:
 *   MATRIX_HOMESERVER_URL   - Required: base URL of the homeserver
 *                             (https://matrix.example.org)
 *   MATRIX_ACCESS_TOKEN     - Required: access token for the bot account
 *   MATRIX_DM_USERS         - Optional: comma-separated MXID whitelist for DMs.
 *                             When set, DMs from anyone else are dropped.
 *   MATRIX_AUTOJOIN         - Optional: "false" to ignore room invites
 *                             (default: accept them)
 *   MATRIX_INVITE_ALLOWLIST - Optional: comma-separated MXIDs whose invites are
 *                             accepted. When set, all other invites are declined.
 *   MATRIX_STORAGE_FILE     - Optional: JSON file persisting the /sync token, so
 *                             a restart resumes rather than replaying
 *   MATRIX_SUBSCRIPTIONS_FILE - Optional: JSON file persisting ambient
 *                             subscriptions across restarts
 *   MATRIX_BACKSCROLL_LIMIT - Optional: messages fetched on first interaction
 *                             with a room (default 50)
 *   MATRIX_ACCEPT_NOTICES   - Optional: "true" to deliver m.notice messages
 *                             (default: dropped, as they come from other bots)
 *   MATRIX_MCPL_DEBUG_LOG   - Optional: absolute path for a diagnostic file log
 */

import * as net from 'node:net';
import { McplConnection } from '@animalabs/mcpl-core';
import { LogService, LogLevel } from 'matrix-bot-sdk';
import { connectMatrix } from './matrix-adapter.js';
import { MatrixMcplServer } from './server.js';

function csv(value: string | undefined): string[] | undefined {
  const parts = value?.split(',').map((s) => s.trim()).filter(Boolean);
  return parts && parts.length > 0 ? parts : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useStdio = args.includes('--stdio');
  const tcpIdx = args.indexOf('--tcp');
  const tcpPort = tcpIdx >= 0 ? parseInt(args[tcpIdx + 1], 10) : undefined;

  if (!useStdio && !tcpPort) {
    console.error('Usage: matrix-mcpl --stdio | --tcp <port>');
    process.exit(1);
  }

  const homeserverUrl = process.env.MATRIX_HOMESERVER_URL;
  const accessToken = process.env.MATRIX_ACCESS_TOKEN;
  if (!homeserverUrl || !accessToken) {
    console.error('MATRIX_HOMESERVER_URL and MATRIX_ACCESS_TOKEN environment variables are required');
    process.exit(1);
  }

  // In stdio mode stdout IS the protocol channel — matrix-bot-sdk logs to it
  // by default, which would corrupt every frame. Route its logging to stderr
  // and keep it quiet.
  LogService.setLogger({
    info: (mod, ...m) => console.error(`[matrix-sdk] ${mod}`, ...m),
    warn: (mod, ...m) => console.error(`[matrix-sdk] ${mod}`, ...m),
    error: (mod, ...m) => console.error(`[matrix-sdk] ${mod}`, ...m),
    debug: () => {},
    trace: () => {},
  });
  LogService.setLevel(process.env.MATRIX_MCPL_DEBUG_LOG ? LogLevel.INFO : LogLevel.ERROR);

  // Connect Matrix first: whoami resolves the bot's identity, then the sync
  // loop comes up so no events are missed once the host attaches.
  const matrix = await connectMatrix({
    homeserverUrl,
    accessToken,
    dmUsers: csv(process.env.MATRIX_DM_USERS),
    autojoin: process.env.MATRIX_AUTOJOIN !== 'false',
    inviteAllowlist: csv(process.env.MATRIX_INVITE_ALLOWLIST),
    storagePath: process.env.MATRIX_STORAGE_FILE,
    acceptNotices: process.env.MATRIX_ACCEPT_NOTICES === 'true',
  });
  const server = new MatrixMcplServer(matrix);
  await matrix.start();
  console.error(
    `[matrix-mcpl] Matrix connected as ${matrix.userId}` +
      (matrix.displayName ? ` ("${matrix.displayName}")` : '') +
      ` on ${homeserverUrl}`,
  );
  if (!process.env.MATRIX_STORAGE_FILE) {
    console.error(
      '[matrix-mcpl] MATRIX_STORAGE_FILE is unset: the sync position is not persisted, so ' +
        'messages sent while this server is down will be missed rather than delivered on restart.',
    );
  }

  const shutdown = () => {
    matrix.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (useStdio) {
    // Stdio transport — single client, MCP-compatible
    // Log to stderr (stdout is the protocol channel)
    console.error('[matrix-mcpl] Starting on stdio');
    const conn = McplConnection.fromStreams(process.stdin, process.stdout);
    await server.serve(conn);
  } else if (tcpPort) {
    // TCP transport — single client
    console.error(`[matrix-mcpl] Listening on TCP port ${tcpPort}`);
    const tcpServer = net.createServer();
    tcpServer.listen(tcpPort, '127.0.0.1');

    await new Promise<void>((resolve) => tcpServer.once('listening', resolve));

    // Accept and serve one connection at a time
    while (true) {
      const conn = await McplConnection.acceptTcp(tcpServer);
      console.error('[matrix-mcpl] Client connected');
      await server.serve(conn);
      console.error('[matrix-mcpl] Client disconnected, waiting for next...');
    }
  }
}

main().catch((err) => {
  console.error('[matrix-mcpl] Fatal error:', err);
  process.exit(1);
});
