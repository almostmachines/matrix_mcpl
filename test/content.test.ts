import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeEntities,
  extractMentionedUserIds,
  markdownToMatrixHtml,
  matrixHtmlToText,
  mediaDownloadUrl,
  mentionsUser,
  parseMxcUrl,
  sanitizeMatrixHtml,
  stripMxReply,
  stripReplyFallback,
} from '../src/content.js';

// ── mxc:// URIs ──

test('parseMxcUrl splits server and media ID', () => {
  assert.deepEqual(parseMxcUrl('mxc://example.org/AbCdEf123'), {
    serverName: 'example.org',
    mediaId: 'AbCdEf123',
  });
});

test('parseMxcUrl ignores trailing path segments', () => {
  assert.equal(parseMxcUrl('mxc://example.org/media/thumbnail').mediaId, 'media');
});

test('parseMxcUrl rejects non-mxc schemes', () => {
  // The access token rides on this request — an https:// value smuggled into
  // an event must never reach the fetcher.
  assert.throws(() => parseMxcUrl('https://evil.example/steal'), /not an mxc/);
  assert.throws(() => parseMxcUrl('mxc://example.org'), /malformed/);
});

test('mediaDownloadUrl targets the configured homeserver on the v1 endpoint', () => {
  assert.equal(
    mediaDownloadUrl('https://matrix.example.org/', 'mxc://other.server/abc123'),
    'https://matrix.example.org/_matrix/client/v1/media/download/other.server/abc123',
  );
});

// ── Outgoing: markdown → Matrix HTML ──

test('markdownToMatrixHtml returns null for plain prose', () => {
  // No markup means no formatted_body — a bare sentence should not be
  // wrapped in a pointless <p>.
  assert.equal(markdownToMatrixHtml('just a plain sentence'), null);
});

test('markdownToMatrixHtml renders emphasis, code and links', () => {
  const html = markdownToMatrixHtml('**bold** and `code` and [a link](https://example.org)');
  assert.ok(html);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.org">a link<\/a>/);
});

test('markdownToMatrixHtml renders fenced code blocks', () => {
  const html = markdownToMatrixHtml('```js\nconst x = 1;\n```');
  assert.ok(html);
  assert.match(html, /<pre>/);
  assert.match(html, /const x = 1;/);
});

test('sanitizeMatrixHtml drops scripts, handlers and javascript: URLs', () => {
  assert.equal(sanitizeMatrixHtml('<script>alert(1)</script>hi'), 'hi');
  assert.equal(sanitizeMatrixHtml('<b onclick="steal()">x</b>'), '<b>x</b>');
  assert.equal(sanitizeMatrixHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
  // Disallowed tags are unwrapped, not deleted with their text.
  assert.equal(sanitizeMatrixHtml('<marquee>keep me</marquee>'), 'keep me');
});

test('sanitizeMatrixHtml keeps the allowed subset intact', () => {
  const html = '<blockquote><p>quoted <em>text</em></p></blockquote>';
  assert.equal(sanitizeMatrixHtml(html), html);
  assert.equal(sanitizeMatrixHtml('<img src="mxc://a/b" alt="pic">'), '<img src="mxc://a/b" alt="pic" />');
});

// ── Incoming: Matrix HTML → text ──

test('matrixHtmlToText renders user pills as @Name (mxid:…)', () => {
  const text = matrixHtmlToText('<a href="https://matrix.to/#/@alice:example.org">Alice</a> hello');
  assert.equal(text, '@Alice (mxid:@alice:example.org) hello');
});

test('matrixHtmlToText handles percent-encoded pill targets', () => {
  const text = matrixHtmlToText('<a href="https://matrix.to/#/%40bob%3Aexample.org">Bob</a>');
  assert.equal(text, '@Bob (mxid:@bob:example.org)');
});

test('matrixHtmlToText keeps plain links with their target', () => {
  assert.equal(
    matrixHtmlToText('see <a href="https://example.org/x">the docs</a>'),
    'see the docs (https://example.org/x)',
  );
});

test('matrixHtmlToText strips the mx-reply fallback', () => {
  // The parent message is already in the agent's context; re-sending it as a
  // quote would duplicate the turn.
  const html =
    '<mx-reply><blockquote>original message</blockquote></mx-reply>actual reply';
  assert.equal(matrixHtmlToText(html), 'actual reply');
  assert.equal(stripMxReply('<mx-reply>x</mx-reply>y'), 'y');
});

test('matrixHtmlToText converts block structure to newlines', () => {
  assert.equal(matrixHtmlToText('<p>one</p><p>two</p>'), 'one\n\ntwo');
  assert.equal(matrixHtmlToText('a<br/>b'), 'a\nb');
  assert.equal(matrixHtmlToText('<ul><li>one</li><li>two</li></ul>'), '- one\n- two');
});

test('matrixHtmlToText fences code blocks and backticks inline code', () => {
  assert.equal(
    matrixHtmlToText('<pre><code>const x = 1;</code></pre>'),
    '```\nconst x = 1;\n```',
  );
  assert.equal(matrixHtmlToText('use <code>npm i</code> here'), 'use `npm i` here');
});

test('matrixHtmlToText decodes entities', () => {
  assert.equal(matrixHtmlToText('a &amp; b &lt;c&gt;'), 'a & b <c>');
  assert.equal(decodeEntities('&#8212; &#x2014;'), '— —');
});

test('stripReplyFallback removes the quoted plain-text prefix', () => {
  const body = '> <@alice:example.org> original\n> second quoted line\n\nmy actual reply';
  assert.equal(stripReplyFallback(body), 'my actual reply');
});

test('stripReplyFallback leaves an ordinary quote alone when it is the whole message', () => {
  // No blank separator and nothing after it — this is someone quoting, not a
  // reply fallback, so returning empty would lose the message.
  assert.equal(stripReplyFallback('plain message'), 'plain message');
});

// ── Mentions ──

test('extractMentionedUserIds reads m.mentions', () => {
  const ids = extractMentionedUserIds({
    body: 'hi',
    'm.mentions': { user_ids: ['@bot:example.org', '@alice:example.org'] },
  });
  assert.deepEqual(ids.sort(), ['@alice:example.org', '@bot:example.org']);
});

test('extractMentionedUserIds falls back to matrix.to pills', () => {
  const ids = extractMentionedUserIds({
    body: 'Bot: hi',
    formatted_body: '<a href="https://matrix.to/#/@bot:example.org">Bot</a>: hi',
  });
  assert.deepEqual(ids, ['@bot:example.org']);
});

test('extractMentionedUserIds ignores pills inside the reply fallback', () => {
  // The mx-reply quote names whoever was replied to; that is not a mention
  // of them by this message.
  const ids = extractMentionedUserIds({
    body: 'sure',
    formatted_body:
      '<mx-reply><blockquote><a href="https://matrix.to/#/@bot:example.org">Bot</a> said x</blockquote></mx-reply>sure',
  });
  assert.deepEqual(ids, []);
});

test('mentionsUser matches m.mentions, pills, and the display name', () => {
  const bot = '@bot:example.org';
  assert.ok(mentionsUser({ body: 'hi', 'm.mentions': { user_ids: [bot] } }, bot));
  assert.ok(mentionsUser({ body: 'hey @bot:example.org' }, bot));
  assert.ok(mentionsUser({ body: 'Aria, are you there?' }, bot, 'Aria'));
  assert.ok(mentionsUser({ body: 'hey bot can you help' }, bot));
});

test('mentionsUser ignores an @room broadcast', () => {
  // Room-wide pings are ambient, not personal address — the same call
  // slack-mcpl makes for @here/@channel.
  assert.equal(mentionsUser({ body: 'everyone look at this', 'm.mentions': { room: true } }, '@bot:example.org'), false);
});

test('mentionsUser does not match a substring of another word', () => {
  assert.equal(mentionsUser({ body: 'rebooting the server' }, '@bot:example.org'), false);
});

test('mentionsUser ignores a mention that only appears in the reply fallback', () => {
  const content = {
    body: '> <@bot:example.org> earlier thing\n\nyeah agreed',
    formatted_body: '<mx-reply><blockquote>earlier thing</blockquote></mx-reply>yeah agreed',
  };
  assert.equal(mentionsUser(content, '@bot:example.org'), false);
});
