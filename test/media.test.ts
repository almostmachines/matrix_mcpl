import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';

import { mediaDownloadUrl, mediaThumbnailUrl, parseMxcUrl } from '../src/content.js';

// ── Thumbnail URLs ──

test('mediaThumbnailUrl hits the authenticated v1 thumbnail endpoint', () => {
  const url = new URL(mediaThumbnailUrl('https://matrix.example.org', 'mxc://other.server/abc123'));
  assert.equal(url.origin, 'https://matrix.example.org');
  assert.equal(url.pathname, '/_matrix/client/v1/media/thumbnail/other.server/abc123');
  assert.equal(url.searchParams.get('width'), '800');
  assert.equal(url.searchParams.get('height'), '800');
  assert.equal(url.searchParams.get('method'), 'scale');
});

test('mediaThumbnailUrl honours explicit dimensions', () => {
  const url = new URL(
    mediaThumbnailUrl('https://matrix.example.org/', 'mxc://s/i', { width: 320, height: 240, method: 'crop' }),
  );
  assert.equal(url.searchParams.get('width'), '320');
  assert.equal(url.searchParams.get('height'), '240');
  assert.equal(url.searchParams.get('method'), 'crop');
});

test('thumbnail and download URLs share the homeserver, never the media server', () => {
  // The access token rides on these requests. Media is addressed by opaque
  // server+id, so a foreign server name in the URI must not redirect the token.
  const mxc = 'mxc://evil.example/xyz';
  for (const u of [
    mediaDownloadUrl('https://matrix.example.org', mxc),
    mediaThumbnailUrl('https://matrix.example.org', mxc),
  ]) {
    assert.equal(new URL(u).origin, 'https://matrix.example.org');
  }
});

test('thumbnail URL rejects a non-mxc scheme', () => {
  assert.throws(() => mediaThumbnailUrl('https://matrix.example.org', 'https://evil/x'), /not an mxc/);
});

// ── saveTo path confinement ──
//
// Mirrors MatrixMcplServer.resolveSavePath. The filename originates in an
// incoming message, so anyone who can post in a watched room can propose one:
// writes must stay inside the configured root.

function resolveSavePath(root: string | undefined, requested: string): string {
  if (!root) throw new Error('saveTo is not available: set MATRIX_SAVE_ROOT');
  const rootAbs = resolve(root);
  const dest = resolve(rootAbs, requested);
  if (dest !== rootAbs && !dest.startsWith(rootAbs + sep)) {
    throw new Error(`saveTo must stay within ${rootAbs} (got "${requested}")`);
  }
  if (dest === rootAbs) throw new Error('saveTo must name a file, not the root directory');
  return dest;
}

test('saveTo resolves plain names and subpaths under the root', () => {
  assert.equal(resolveSavePath('/srv/out', 'photo.jpg'), '/srv/out/photo.jpg');
  assert.equal(resolveSavePath('/srv/out', 'nested/photo.jpg'), '/srv/out/nested/photo.jpg');
});

test('saveTo refuses traversal out of the root', () => {
  for (const bad of ['../escape.jpg', 'a/../../escape.jpg', '/etc/passwd', '../out-sibling/x.jpg']) {
    assert.throws(() => resolveSavePath('/srv/out', bad), /must stay within/, `should reject ${bad}`);
  }
});

test('saveTo refuses a prefix-collision sibling directory', () => {
  // /srv/output starts with /srv/out as a string but is a different directory —
  // the separator check is what makes this fail.
  assert.throws(() => resolveSavePath('/srv/out', '../output/x.jpg'), /must stay within/);
});

test('saveTo refuses the root itself and is off without a root', () => {
  assert.throws(() => resolveSavePath('/srv/out', '.'), /must name a file/);
  assert.throws(() => resolveSavePath(undefined, 'photo.jpg'), /not available/);
});
