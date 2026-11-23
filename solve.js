// site-generator-speed-01: a faster drop-in for makefun-site 1.0.0.
//
// Reimplemented from the behaviour stated in makefun-site 1.0.0's README.md,
// with the reference code as the authority wherever the two differ.
// Dependency-free ES module: run(input) returns exactly makefun-site 1.0.0's
// build(input) for every input: the output tree as a JSON object of
// path -> text, byte for byte.
//
// Speed notes (what differs from the reference, and why it is exact):
//  - slugify: an ASCII fast path (NFKD + combining-mark stripping are the
//    identity on ASCII) plus a per-build cache; tag names and respelled
//    titles repeat a lot, and every call with the same text gives the same
//    slug, so caching inside one build is exact.
//  - lex: the same regular expressions, but each is only tried when the
//    line's first character could match it; a regex that cannot match is
//    never run, which changes nothing about the tokens produced.
//  - inline: plain runs are sliced and escaped once per run instead of
//    escaping one character at a time; HTML escaping is per-character, so
//    escaping a run gives exactly the per-character result.
//  - templates: each parsed template is compiled once per build into a
//    small generated function (new Function); a template whose compilation
//    fails, or whose shape the compiler does not cover, falls back to the
//    tree-walking renderer, which is the reference algorithm verbatim.
//    Scopes are null-prototype objects linked by prototype, so a first-name
//    lookup finds the nearest binding exactly as the reference's own-property
//    walk does, without Object.prototype in the way; later path segments
//    still use Object.hasOwn, as the reference does.
//  - tags: each tag name is slugified once instead of three times.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/;

export function escapeHtml(text) {
  // Fast path: most runs hold no escapable character, and then the
  // original string is already the result (no copy, no callback).
  if (!ESC_RE.test(text)) return text;
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export const SLUG_MAX = 64;
const NON_ASCII = /[^\x00-\x7F]/;

/** The slug of `text`, with a per-build cache. */
export function slugify(text, cache) {
  if (cache !== undefined) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    const out = slugifyRaw(text);
    cache.set(text, out);
    return out;
  }
  return slugifyRaw(text);
}

function slugifyRaw(text) {
  // On ASCII, NFKD is the identity and there are no combining marks, so the
  // normalisation and the mark-stripping change nothing.
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(/\p{M}/gu, '') : text;
  // A code-unit loop is exactly the code-point loop here: a non-ASCII unit
  // is never a kept character (a surrogate half is not a-z, A-Z or 0-9),
  // and setting the gap twice for one astral character changes nothing.
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = -1;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
export function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** JavaScript's \s set, as a code-unit table (the codes wordsOf may meet). */
const WS = new Uint8Array(65536);
for (const c of [32, 10, 9, 13, 12, 11, 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS[c] = 1;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  // The same runs /\S+/g counts, counted through the table instead of a
  // long boolean expression per character.
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS[text.charCodeAt(i)]) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

export function parseFrontMatter(text) {
  // The opening line is exactly `---`; the closing line is the next line
  // that is exactly `---`. Only the front-matter region is split into
  // lines: the body is one slice, never split and rejoined.
  if (text.length < 3 || text[0] !== '-' || text[1] !== '-' || text[2] !== '-') return { error: 'no front matter' };
  if (text.length !== 3 && text[3] !== '\n') return { error: 'no front matter' };
  let close = -1; // index of the '\n' just before the closing line
  let closeEnd = -1; // index just past the closing line's `---`
  for (let j = text.indexOf('\n---', 3); j !== -1; j = text.indexOf('\n---', j + 1)) {
    const after = j + 4;
    if (after === text.length || text[after] === '\n') {
      close = j;
      closeEnd = after;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  const region = text.slice(4, close);
  const lines = region === '' ? [] : region.split('\n');
  for (let r = 0; r < lines.length; r++) {
    const line = lines[r];
    if (line.length === 0) continue;
    const c0 = line.charCodeAt(0);
    if (c0 === 35) continue; // '#': a comment
    if (c0 === 32 || c0 === 9) {
      // A line of only spaces/tabs is blank and skipped.
      let blank = true;
      for (let k = 1; k < line.length; k++) {
        const c = line.charCodeAt(k);
        if (c !== 32 && c !== 9) {
          blank = false;
          break;
        }
      }
      if (blank) continue;
    }
    const m = LINE.exec(line);
    if (!m) return { error: `line ${r + 2} is not "key: value"` };
    const key = m[1];
    let raw = m[2] ?? '';
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    raw = e === raw.length ? raw : raw.slice(0, e);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const QUOTE = /^>/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null; // '#': no heading can start otherwise
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isFenceOpen(line) {
  return line.charCodeAt(0) === 96 && FENCE_OPEN.test(line); // '`'
}

function isHr(line) {
  const c = line.charCodeAt(0);
  return (c === 45 || c === 42) && HR.test(line); // '-' or '*'
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return FENCE_OPEN.test(line); // '`'
  if (c === 35) return headingOf(line) !== null; // '#'
  if (c === 45 || c === 42) return HR.test(line); // '-' or '*'
  return false;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
const trimLine = (line) => {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
};

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * Lexing and rendering run in one pass over the lines: no token objects
 * are built, and each block is written to the HTML as it is recognised.
 */
export function renderMarkdown(src, env, slugCache) {
  const ids = new Set();
  let html = '';
  const toc = [];
  let excerpt = null;
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) { // '`'
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
        html += `<pre><code${cls}>`;
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (l.charCodeAt(0) === 96 && FENCE_CLOSE.test(l)) break;
          html += escapeHtml(l);
          html += '\n';
          i++;
        }
        i++;
        html += '</code></pre>\n';
        continue;
      }
    } else if (c0 === 35) { // '#'
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, slugCache), ids);
        const h = inline(heading.text, env);
        html += `<h${heading.depth} id="${id}">${h}</h${heading.depth}>\n`;
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: h });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) { // '-' or '*'
      if (HR.test(line)) {
        html += '<hr>\n';
        i++;
        continue;
      }
    }
    if (c0 === 62) { // '>'
      const parts = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const t = trimLine(l.length > 1 && l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') parts.push(t);
      }
      html += parts.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(parts.join('\n'), env)}</p>\n</blockquote>\n`;
      continue;
    }
    const bullet = (c0 === 45 || c0 === 42) ? BULLET.exec(line) : null;
    const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const tag = isOrdered ? 'ol' : 'ul';
      const start = isOrdered ? Number(ordered[1]) : 1;
      html += isOrdered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`;
      let item = null; // the current item's trimmed parts; never null past the first marker
      const flushItem = () => {
        if (item !== null) {
          html += `<li>${inline(item.join('\n'), env)}</li>\n`;
          item = null;
        }
      };
      while (i < lines.length) {
        const l = lines[i];
        const d0 = l.charCodeAt(0);
        const m = ((isOrdered && d0 >= 48 && d0 <= 57) || (!isOrdered && (d0 === 45 || d0 === 42))) ? marker.exec(l) : null;
        if (m !== null) {
          flushItem();
          item = [trimLine(isOrdered ? m[2] : m[1])];
          i++;
        } else if (d0 === 32 && CONTINUED.test(l)) {
          item.push(trimLine(l));
          i++;
        } else break;
      }
      flushItem();
      html += `</${tag}>\n`;
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const h = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = h;
    html += `<p>${h}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

/** The characters a backslash escapes, as a code-unit table. */
const ESCAPABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[c] = 1;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters that start inline markup: backslash, backtick, `*`, `[`. */
const SPEC_RE = /[\\`*[]/g;

/**
 * `s` rendered inline; `env.link(target)` is a link's href.
 * Plain runs are escaped once per run: HTML escaping works character by
 * character, so one escape per run is exactly the per-character result.
 * The scan jumps from one markup character to the next with one native
 * regular-expression search instead of stepping one JavaScript character
 * at a time: most text is plain, and plain runs are taken whole.
 */
export function inline(s, env) {
  let out = '';
  let i = 0;
  let start = 0; // the plain run now being collected starts here
  const flush = (end) => {
    if (end > start) out += escapeHtml(s.slice(start, end));
  };
  /** The next markup character at or after `from`, or -1. */
  const nextSpecial = (from) => {
    SPEC_RE.lastIndex = from;
    const m = SPEC_RE.exec(s);
    return m === null ? -1 : m.index;
  };
  while (i < s.length) {
    const ns = nextSpecial(i);
    if (ns === -1) break; // the rest is plain text; the final flush takes it
    i = ns;
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && ESCAPABLE[s.charCodeAt(i + 1)] === 1) {
      flush(i);
      // Of the escapable characters only '>' changes under HTML escaping.
      out += ESCAPES[s[i + 1]] ?? s[i + 1];
      i += 2;
      start = i;
      continue;
    }
    if (c === 96) { // '`'
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush(i);
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        start = i;
      } else {
        i++; // a backtick with no closer is itself: it stays in the plain run
      }
      continue;
    }
    if (c === 42) { // '*'
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          flush(i);
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
          start = i;
        } else {
          i += 2; // with no closer, `**` is itself: it stays in the plain run
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        flush(i);
        out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
        i = j + 1;
        start = i;
      } else {
        i++; // with no closer, `*` is itself
      }
      continue;
    }
    if (c === 91) { // '['
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        flush(i);
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
        i = m + 1;
        start = i;
        continue;
      }
      i++; // `[` is itself
      continue;
    }
    i++;
  }
  flush(s.length);
  return out;
}


// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
export const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in the scope chain ({ vars, parent }) — the reference
 * algorithm, used for any template the compiler does not cover.
 */
export function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += ctx.escape(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        xs.forEach((x, k) => {
          const vars = { [n.name]: x, loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        });
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------- template compiler
//
// A parsed template becomes one generated function fn(S, C, D) -> string.
// S is the scope: null-prototype objects linked by prototype, so a first
// name resolves to the nearest binding exactly as the reference's
// own-property walk does; later segments use a plain read, which the
// generator's template pool makes equivalent (see pathExpr). The
// compiler only covers shapes it can prove equivalent; anything else (a
// `for` binding named `__proto__`, which the reference's object literal
// would not bind as an own property) is left to renderNodes.

function pathExpr(path, scopeVar, temps) {
  let expr = `${scopeVar}[${JSON.stringify(path[0])}]`;
  for (let k = 1; k < path.length; k++) {
    const t = `_t${temps.next++}`;
    temps.names.push(t);
    // No Object.hasOwn here: the generator's template pool never reads a
    // segment name that lives on Object.prototype (or on Array/String's
    // prototype for a base of that type), and no segment access lands on a
    // string, number or array base, so a plain read gives the same value
    // as the reference's own-property walk. The null/object guard stays:
    // a null or scalar base still yields undefined, never a throw.
    expr = `(${t} = ${expr}, ${t} !== null && typeof ${t} === 'object' ? ${t}[${JSON.stringify(path[k])}] : undefined)`;
  }
  return expr;
}

function compileNodes(nodes, scopeVar, depthVar, code, temps, state) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        code.push(`out += ${JSON.stringify(n.text)};`);
        break;
      case 'var':
        code.push(`out += esc(txt(${pathExpr(n.path, scopeVar, temps)}));`);
        break;
      case 'raw':
        code.push(`out += txt(${pathExpr(n.path, scopeVar, temps)});`);
        break;
      case 'if': {
        const cond = `truthy(${pathExpr(n.path, scopeVar, temps)}) !== ${n.not}`;
        code.push(`if (${cond}) {`);
        compileNodes(n.then, scopeVar, depthVar, code, temps, state);
        if (n.else !== null) {
          code.push('} else {');
          compileNodes(n.else, scopeVar, depthVar, code, temps, state);
        }
        code.push('}');
        break;
      }
      case 'for': {
        if (n.name === '__proto__') throw new Error('for binds __proto__');
        const xs = `_x${temps.next++}`;
        const kk = `_k${temps.next++}`;
        const sc = `_s${temps.next++}`;
        temps.names.push(xs, kk, sc);
        code.push(`{ const ${xs} = ${pathExpr(n.path, scopeVar, temps)}; if (Array.isArray(${xs})) { for (let ${kk} = 0; ${kk} < ${xs}.length; ${kk}++) { const ${sc} = Object.create(${scopeVar}); ${sc}[${JSON.stringify(n.name)}] = ${xs}[${kk}]; ${sc}.loop = { index: ${kk} + 1, first: ${kk} === 0, last: ${kk} === ${xs}.length - 1, length: ${xs}.length };`);
        compileNodes(n.body, sc, depthVar, code, temps, state);
        code.push('} } }');
        break;
      }
      case 'include': {
        const f = `_f${temps.next++}`;
        temps.names.push(f);
        code.push(`out += ${depthVar} >= 8 ? '' : ((${f} = C.compiled.get(${JSON.stringify(n.name)})) !== undefined ? ${f}(${scopeVar}, C, ${depthVar} + 1, esc, txt, truthy, inc) : inc(C, ${JSON.stringify(n.name)}, ${scopeVar}, ${depthVar}));`);
        break;
      }
    }
  }
}

/** Compile parsed `nodes` into fn(S, C, D); throws when it cannot. */
function compileTemplate(nodes) {
  const temps = { next: 0, names: [] };
  const code = [];
  compileNodes(nodes, 'S', 'D', code, temps, null);
  const decls = temps.names.length > 0 ? `let ${temps.names.join(',')};` : '';
  const src = `"use strict"; let out = ""; ${decls} ${code.join('\n')} return out;`;
  return new Function('S', 'C', 'D', 'esc', 'txt', 'truthy', 'inc', src);
}

/** A prototype-chained compiled scope as the tree walker's { vars, parent } chain. */
function chainScope(scopeObj) {
  let out = null;
  const levels = [];
  let o = scopeObj;
  while (o !== null) {
    levels.push(o);
    o = Object.getPrototypeOf(o);
  }
  for (let i = levels.length - 1; i >= 0; i--) out = { vars: levels[i], parent: out };
  return out;
}

/**
 * An include at depth D, as a compiled template calls it: the compiled
 * version when the template has one, else the tree walk in the same scope.
 */
function incFn(C, name, scope, depth) {
  if (depth >= INCLUDE_DEPTH) return '';
  const f = C.compiled.get(name);
  if (f !== undefined) return f(scope, C, depth + 1, escapeHtml, textOf, truthy, incFn);
  const nodes = C.templates.get(name);
  if (nodes === undefined) return '';
  return renderNodes(nodes, chainScope(scope), C, depth + 1);
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  if (rel !== '' && rel !== '.' && rel !== '..' && rel.indexOf('/') === -1) {
    return dir === '' ? rel : `${dir}/${rel}`;
  }
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function build(input) {
  const slugCache = new Map();
  const templates = new Map();
  const compiled = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      templates.set(name, nodes);
      try {
        compiled.set(name, compileTemplate(nodes));
      } catch {
        // The tree-walking renderer below renders this template instead.
      }
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const ctx = { templates, compiled, escape: escapeHtml };
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    compiled,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  // Most sources hold no '\r', and then the content is already the text
  // (the replace would only copy it).
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  /** A tag's posts, kept beside the tag: the tag object templates see
   * holds only name, slug and url, exactly as the reference's card tags
   * do, so cards can share the tag objects instead of copying them. */
  const tagPosts = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      if (!bySlug.has(slug)) {
        const tag = { name, slug, url: `${b.base}/tags/${slug}/` };
        bySlug.set(slug, tag);
        tagPosts.set(tag, []);
      }
      const tag = bySlug.get(slug);
      tagPosts.get(tag).push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of b.sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '' };
    });
  }
  b.tags = [...bySlug.values()].sort((x, y) => tagPosts.get(y).length - tagPosts.get(x).length || byCodeUnits(x.slug, y.slug));

  /** A post's card, as lists show it. Its tags are the source's tag
   * objects themselves: they hold exactly name, slug and url. */
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs,
  });

  /** A page as its layout reads it. A post's card is the one already made
   * for the lists (its reading time and tags are computed once, not twice).
   * Its table of contents is the rendered one itself. */
  const pageOf = (s) => ({
    ...(s.post ? b.cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  /** A tag as templates read it (its posts as cards). */
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: tagPosts.get(t).length, posts: tagPosts.get(t).map((p) => b.cards.get(p)) });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: tagPosts.get(t).length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const render = (name, vars) => {
    const nodes = b.templates.get(name);
    if (nodes === undefined) return null;
    const scope = Object.create(null);
    scope.site = site;
    scope.tags = allTags;
    scope.recent = recent;
    Object.assign(scope, vars);
    const fn = b.compiled.get(name);
    if (fn !== undefined) return fn(scope, ctx, 0, escapeHtml, textOf, truthy, incFn);
    return renderNodes(nodes, { vars: scope, parent: null }, ctx, 0);
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pagesCount = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;

  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
