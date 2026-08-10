/**
 * Content helpers — Matrix message formatting and media handling.
 *
 * Pure functions shared by the server layer and the Matrix adapter. Kept free
 * of client/SDK dependencies so both sides can import without cycles.
 *
 * Matrix carries a message twice: `body` is plain text and `formatted_body`
 * is a restricted HTML subset (spec §"m.room.message msgtypes"). Outgoing,
 * we render the agent's markdown into that subset; incoming, we flatten it
 * back to text the model can read. Slack's mrkdwn helpers occupy the same
 * slot in slack-mcpl.
 */

import { marked } from 'marked';

// Anthropic refuses images larger than this; mirror their cap server-side
// so an over-eager fetch can't poison the agent's next turn.
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

// MIME types we decode and return as `content_text` instead of base64,
// so the agent can read them directly (CSVs, JSON, plain text, etc).
const TEXT_MIME_RE = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|x-www-form-urlencoded)\b)/i;

export interface FetchedAttachment {
  buf: Buffer;
  mimeType: string;
  name: string;
}

// ── mxc:// URIs ──

/**
 * Parse an `mxc://<serverName>/<mediaId>` URI. Media is addressed by opaque
 * server+id, never by URL, so — unlike Slack's `url_private` — there is no
 * attacker-controlled host to guard against: the download always goes to the
 * configured homeserver. The scheme check is still enforced so a `https://…`
 * value smuggled into an event can't be handed to the fetcher.
 */
export function parseMxcUrl(mxcUrl: string): { serverName: string; mediaId: string } {
  if (!mxcUrl) throw new Error('mxcUrl is required');
  if (!mxcUrl.toLowerCase().startsWith('mxc://')) {
    throw new Error(`not an mxc:// URI: ${mxcUrl}`);
  }
  const rest = mxcUrl.slice('mxc://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) throw new Error(`malformed mxc:// URI: ${mxcUrl}`);
  const serverName = rest.slice(0, slash);
  // Trailing path segments are not part of the media ID.
  const mediaId = rest.slice(slash + 1).split('/')[0];
  if (!serverName || !mediaId) throw new Error(`malformed mxc:// URI: ${mxcUrl}`);
  return { serverName, mediaId };
}

/**
 * Build the authenticated media download URL on the configured homeserver.
 * The unauthenticated `/_matrix/media/r0/download` endpoint was frozen in
 * Matrix 1.11 — v1 client media is the only one that still serves remote
 * content, and it requires the access token.
 */
export function mediaDownloadUrl(homeserverUrl: string, mxcUrl: string): string {
  const { serverName, mediaId } = parseMxcUrl(mxcUrl);
  const base = homeserverUrl.replace(/\/+$/, '');
  return `${base}/_matrix/client/v1/media/download/${encodeURIComponent(serverName)}/${encodeURIComponent(mediaId)}`;
}

/**
 * Build the authenticated thumbnail URL for a piece of media. Used to inline a
 * preview of an image too large to carry at full size — the agent still sees
 * what arrived, and the original stays one `fetch_attachment` away.
 */
export function mediaThumbnailUrl(
  homeserverUrl: string,
  mxcUrl: string,
  opts: { width?: number; height?: number; method?: 'scale' | 'crop' } = {},
): string {
  const { serverName, mediaId } = parseMxcUrl(mxcUrl);
  const base = homeserverUrl.replace(/\/+$/, '');
  const q = new URLSearchParams({
    width: String(opts.width ?? 800),
    height: String(opts.height ?? 800),
    method: opts.method ?? 'scale',
  });
  return `${base}/_matrix/client/v1/media/thumbnail/${encodeURIComponent(serverName)}/${encodeURIComponent(mediaId)}?${q}`;
}

/**
 * Authenticated GET with an enforced size cap. Checks Content-Length when the
 * server provides one, and streams with a running byte budget as defense in
 * depth so a missing or lying header can't OOM the process.
 *
 * Deliberately not `MatrixClient.downloadContent`: that buffers the whole body
 * before any size check, and an agent can be talked into fetching a 2GB file
 * by anyone who can post in a room it watches.
 */
export async function fetchAttachmentBytes(
  url: string,
  fallbackName: string,
  opts: { headers?: Record<string, string> } = {},
): Promise<FetchedAttachment> {
  const resp = await fetch(url, { headers: opts.headers ?? {}, redirect: 'follow' });
  if (!resp.ok) throw new Error(`fetch failed: ${resp.status} ${resp.statusText}`);

  // Pre-check Content-Length so an oversized declared body never starts buffering.
  const declared = resp.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment too large: ${n} bytes (max ${MAX_ATTACHMENT_BYTES})`);
    }
  }

  const reader = resp.body?.getReader();
  let buf: Buffer;
  if (!reader) {
    // No streaming body: fall back to arrayBuffer with a post-read check.
    buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment too large: ${buf.byteLength} bytes (max ${MAX_ATTACHMENT_BYTES})`);
    }
  } else {
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_ATTACHMENT_BYTES) {
        reader.cancel().catch(() => {});
        throw new Error(`attachment too large: streamed past ${MAX_ATTACHMENT_BYTES} bytes`);
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    buf = Buffer.concat(chunks, total);
  }

  const headerMime = resp.headers.get('content-type')?.split(';')[0].trim();
  const classified = classifyExtension(fallbackName);
  const mimeType = headerMime || classified.mimeType;
  return { buf, mimeType, name: fallbackName };
}

/**
 * Shape a successful fetch into the tool's response. Images return as native
 * MCP content blocks (via `_content`), text-ish MIME types return decoded
 * `content_text`, other binary returns `base64`.
 */
export function toFetchResult({ buf, mimeType, name }: FetchedAttachment): Record<string, unknown> {
  if (mimeType.startsWith('image/')) {
    return {
      _content: [
        { type: 'text', text: `Fetched ${name} (${mimeType}, ${buf.byteLength} bytes):` },
        { type: 'image', data: buf.toString('base64'), mimeType },
      ],
    };
  }
  if (TEXT_MIME_RE.test(mimeType)) {
    return {
      name,
      mimeType,
      size: buf.byteLength,
      content_text: buf.toString('utf-8'),
    };
  }
  return {
    name,
    mimeType,
    size: buf.byteLength,
    base64: buf.toString('base64'),
    note: 'Non-image, non-text attachment returned as base64. Decode externally as needed.',
  };
}

export interface AttachmentRef {
  /** mxc:// URI — resolved against the homeserver by fetch_attachment. */
  path: string;
  name: string;
  mimeType: string;
  isImage: boolean;
  size?: number;
}

const IMAGE_EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const NONIMAGE_EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
};

export function classifyExtension(name: string): { mimeType: string; isImage: boolean } {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXT_MIME[ext]) return { mimeType: IMAGE_EXT_MIME[ext], isImage: true };
  if (NONIMAGE_EXT_MIME[ext]) return { mimeType: NONIMAGE_EXT_MIME[ext], isImage: false };
  return { mimeType: 'application/octet-stream', isImage: false };
}

// ── HTML entities ──

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, name: string) => {
    const direct = ENTITIES[name];
    if (direct !== undefined) return direct;
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = parseInt(name.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    if (name.startsWith('#')) {
      const code = parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Outgoing: markdown → Matrix HTML ──

/** The tag allowlist from the Matrix spec's `org.matrix.custom.html` subset. */
const ALLOWED_TAGS = new Set([
  'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'p', 'a', 'ul', 'ol', 'sup', 'sub',
  'li', 'b', 'i', 'u', 'strong', 'em', 'strike', 'code', 'hr', 'br', 'div', 'table', 'thead',
  'tbody', 'tr', 'th', 'td', 'caption', 'pre', 'span', 'img', 'details', 'summary',
]);

/** Per-tag attribute allowlist. Everything not listed here is dropped — which
 *  removes every `on*` handler and `style` in one move. */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'name', 'target', 'rel']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  ol: new Set(['start']),
  code: new Set(['class']),
  span: new Set(['data-mx-bg-color', 'data-mx-color', 'data-mx-spoiler']),
  font: new Set(['data-mx-bg-color', 'data-mx-color', 'color']),
};

/** Schemes permitted in `href`/`src`. `javascript:` and `data:` are the point. */
const SAFE_URL_RE = /^(https?:|mxc:|mailto:|ftp:|magnet:|#)/i;

/**
 * Reduce arbitrary HTML to the subset Matrix clients will render. Disallowed
 * tags are unwrapped (their text survives), disallowed attributes are dropped,
 * and `<script>`/`<style>` are removed with their contents.
 *
 * Clients sanitize on the receiving end too — this is so the agent can't be
 * talked into *emitting* something a lenient client would honour.
 */
export function sanitizeMatrixHtml(html: string): string {
  let out = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');

  return out.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (match, rawTag: string, rawAttrs: string) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return ''; // unwrap: drop the tag, keep the text
    if (match.startsWith('</')) return `</${tag}>`;

    const allowed = ALLOWED_ATTRS[tag];
    let attrs = '';
    if (allowed) {
      const attrRe = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(rawAttrs)) !== null) {
        const name = m[1].toLowerCase();
        if (!allowed.has(name)) continue;
        const value = m[3] ?? m[4] ?? '';
        if ((name === 'href' || name === 'src') && !SAFE_URL_RE.test(decodeEntities(value).trim())) continue;
        attrs += ` ${name}="${escapeHtml(decodeEntities(value))}"`;
      }
    }
    const selfClosing = /\/\s*$/.test(rawAttrs) || tag === 'br' || tag === 'hr' || tag === 'img';
    return selfClosing ? `<${tag}${attrs} />` : `<${tag}${attrs}>`;
  });
}

/**
 * Render the agent's markdown into Matrix's HTML subset. Returns `null` when
 * the text has no markup worth sending — a plain sentence should go out as
 * `body` alone rather than a pointless `<p>` wrapper.
 */
export function markdownToMatrixHtml(markdown: string): string | null {
  const rendered = marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string;
  const html = sanitizeMatrixHtml(rendered).trim();

  // Strip the single enclosing <p> marked adds to one-paragraph input; if
  // nothing but that wrapper distinguishes it from the source, send plain.
  const unwrapped = html.replace(/^<p>([\s\S]*)<\/p>$/, '$1');
  if (!/<[a-zA-Z]/.test(unwrapped) && decodeEntities(unwrapped).trim() === markdown.trim()) {
    return null;
  }
  return html;
}

/** Format a mention of a user as Matrix expects it: a matrix.to pill. */
export function userPill(userId: string, displayName?: string): string {
  return `<a href="https://matrix.to/#/${encodeURIComponent(userId)}">${escapeHtml(displayName || userId)}</a>`;
}

// ── Incoming: Matrix HTML → readable text ──

/** Matrix rich replies embed a quote of the parent in both `body` (as `> `
 *  lines) and `formatted_body` (as `<mx-reply>`). The agent already has the
 *  parent in its context, so the fallback is stripped from both. */
export function stripReplyFallback(body: string): string {
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('> ')) i++;
  // The fallback block is followed by one blank separator line.
  if (i > 0 && i < lines.length && lines[i].trim() === '') i++;
  return i > 0 ? lines.slice(i).join('\n') : body;
}

export function stripMxReply(html: string): string {
  return html.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/gi, '');
}

const MATRIX_TO_RE = /^https?:\/\/matrix\.to\/#\/([^?/]+)/i;

/**
 * Flatten `formatted_body` into text the model can read. Mentions become
 * `@Name (mxid:@user:server)` — the same shape slack-mcpl uses for
 * `<@U123>` — so the agent can copy an ID straight back into a tool call.
 */
export function matrixHtmlToText(html: string): string {
  let text = stripMxReply(html);

  // Code comes out first, before the block-structure pass below eats the
  // `</pre>` its own rule depends on. Each block is parked behind a
  // placeholder and restored at the very end, so no later pass — including
  // the final entity decode — touches the code's own text.
  const parked: string[] = [];
  const park = (content: string): string => `\u0000CODE${parked.push(content) - 1}\u0000`;

  text = text.replace(
    /<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_m, code: string) => park(`\n\`\`\`\n${decodeEntities(stripTags(code)).replace(/\n+$/, '')}\n\`\`\`\n`),
  );
  text = text.replace(
    /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
    (_m, code: string) => park(`\n\`\`\`\n${decodeEntities(stripTags(code)).replace(/\n+$/, '')}\n\`\`\`\n`),
  );
  text = text.replace(
    /<code\b[^>]*>([\s\S]*?)<\/code>/gi,
    (_m, code: string) => park(`\`${decodeEntities(stripTags(code))}\``),
  );

  // Block-level structure → newlines, before tags are stripped.
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|h[1-6]|tr|table|blockquote)\s*>/gi, '\n\n');
  text = text.replace(/<li\b[^>]*>/gi, '\n- ');
  text = text.replace(/<\/li\s*>/gi, '');
  text = text.replace(/<hr\s*\/?>/gi, '\n---\n');

  // Links: matrix.to pills carry the ID the agent needs; plain links keep
  // their target so the agent can quote or follow it. Labels and hrefs are
  // emitted still-escaped — the single decode pass at the end covers them,
  // and decoding here as well would collapse `&amp;amp;` down to `&`.
  text = text.replace(/<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, _q, dq: string | undefined, sq: string | undefined, label: string) => {
      const rawHref = (dq ?? sq ?? '').trim();
      const labelText = stripTags(label).trim();
      const pill = MATRIX_TO_RE.exec(decodeEntities(rawHref));
      if (pill) {
        const target = safeDecodeUri(pill[1]);
        if (target.startsWith('@')) return `@${labelText || target} (mxid:${target})`;
        if (target.startsWith('#') || target.startsWith('!')) {
          return labelText && labelText !== target ? `${target} (${labelText})` : target;
        }
      }
      if (!labelText) return rawHref;
      return labelText === rawHref ? rawHref : `${labelText} (${rawHref})`;
    });

  // Images: no bytes here — name them so the agent knows something arrived.
  text = text.replace(/<img\b[^>]*alt\s*=\s*"([^"]*)"[^>]*>/gi, '[image: $1]');
  text = text.replace(/<img\b[^>]*>/gi, '[image]');

  text = stripTags(text);
  text = decodeEntities(text);
  // Collapse the newline runs the block replacements above tend to produce.
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text.replace(/\u0000CODE(\d+)\u0000/g, (_m, i: string) => parked[Number(i)] ?? '').trim();
}

/** decodeURIComponent that tolerates malformed input (`%zz` throws). */
function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

// ── Mentions ──

/**
 * User IDs this event mentions. `m.mentions.user_ids` (intentional mentions,
 * stable since Matrix 1.7) is authoritative when present; older clients only
 * leave matrix.to pills in `formatted_body`, so both are read.
 *
 * `m.mentions.room` — the `@room` broadcast — is deliberately NOT a personal
 * mention, mirroring how slack-mcpl treats `@here`/`@channel`.
 */
export function extractMentionedUserIds(content: Record<string, unknown>): string[] {
  const ids = new Set<string>();

  const mentions = content['m.mentions'] as { user_ids?: unknown } | undefined;
  if (mentions && Array.isArray(mentions.user_ids)) {
    for (const id of mentions.user_ids) {
      if (typeof id === 'string' && id.startsWith('@')) ids.add(id);
    }
  }

  const formatted = typeof content.formatted_body === 'string' ? stripMxReply(content.formatted_body) : '';
  if (formatted) {
    const re = /https?:\/\/matrix\.to\/#\/((?:%40|@)[^"'?\s/]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(formatted)) !== null) {
      try {
        ids.add(decodeURIComponent(m[1]));
      } catch {
        ids.add(m[1]);
      }
    }
  }

  return [...ids];
}

/** True when `content` mentions `userId` — via m.mentions, a pill, or (for
 *  clients that do neither) the display name at a word boundary in the body. */
export function mentionsUser(
  content: Record<string, unknown>,
  userId: string,
  displayName?: string,
): boolean {
  if (extractMentionedUserIds(content).includes(userId)) return true;

  const body = typeof content.body === 'string' ? stripReplyFallback(content.body) : '';
  if (!body) return false;
  if (body.includes(userId)) return true;

  // Localpart/display-name fallback: `@alice` or a bare `alice:` greeting.
  const candidates = [displayName, userId.slice(1).split(':')[0]].filter(
    (c): c is string => !!c && c.length > 1,
  );
  for (const name of candidates) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^\\w@])@?${escaped}\\b`, 'i').test(body)) return true;
  }
  return false;
}
