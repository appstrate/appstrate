// SPDX-License-Identifier: Apache-2.0

/**
 * Plain-text excerpts of a file's first bytes, for the gallery tiles
 * (`GET /api/files/:id/excerpt`). Leaf module: no DB, no storage — the route
 * reads the bounded prefix and hands the bytes here.
 *
 * Output is plain text, one block per line (`\n`), whitespace collapsed and
 * blank lines dropped: a tile shows a few hundred characters, so indentation
 * and empty lines would only spend that budget. Nothing is ever rendered or
 * executed — HTML goes through `HTMLRewriter` as a tokenizer only.
 */

import { normalizeMime } from "./mime-policy.ts";

type ExcerptKind = "markdown" | "text" | "html";

/**
 * Bytes read from storage per excerpt. Markdown and plain text need ~1 KiB for
 * 400 characters; HTML's `<head>` (inline CSS, scripts, embedded fonts)
 * routinely spans tens of KiB before the first visible word.
 */
export const EXCERPT_READ_BYTES: Readonly<Record<ExcerptKind, number>> = {
  markdown: 8 * 1024,
  text: 8 * 1024,
  html: 64 * 1024,
};

const EXCERPT_MAX_CHARS = 400;

/**
 * Markdown lines past this length end the excerpt there. Keeps the per-line
 * regexes bounded on a single huge line, far above what a tile shows.
 */
const MARKDOWN_MAX_LINE = 1000;

const KIND_BY_MIME: ReadonlyMap<string, ExcerptKind> = new Map([
  ["text/markdown", "markdown"],
  ["text/plain", "text"],
  ["text/csv", "text"],
  ["application/json", "text"],
  ["text/html", "html"],
]);

/**
 * How a file is excerpted, or null when it has no text excerpt (PDF, images…).
 * A `.md` stored under any `text/*` mime is markdown, as the web app reads it.
 */
export function excerptKind(mime: string, name: string): ExcerptKind | null {
  const normalized = normalizeMime(mime);
  if (normalized.startsWith("text/") && name.toLowerCase().endsWith(".md")) return "markdown";
  return KIND_BY_MIME.get(normalized) ?? null;
}

/** Read at most `maxBytes` from the head of `stream`, then cancel it. */
export async function readPrefix(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const out = new Uint8Array(maxBytes);
  let filled = 0;
  try {
    while (filled < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.byteLength, maxBytes - filled);
      out.set(value.subarray(0, take), filled);
      filled += take;
    }
  } finally {
    await reader.cancel();
  }
  return out.subarray(0, filled);
}

/**
 * The excerpt of `bytes` (a file prefix), or null when it holds no text.
 * `truncated` says the prefix is not the whole file: a multibyte character cut
 * at the end is dropped rather than decoded to U+FFFD, and the excerpt ends
 * with "…" even when it is short.
 */
export async function extractExcerpt(
  kind: ExcerptKind,
  bytes: Uint8Array,
  truncated: boolean,
): Promise<string | null> {
  // `stream: true` keeps an incomplete trailing sequence buffered, never emitted.
  const source = new TextDecoder("utf-8").decode(bytes, { stream: truncated });
  if (kind === "markdown") {
    const md = markdownText(source);
    return clamp(toLines(decodeEntities(md.text)), truncated || md.cut);
  }
  return clamp(toLines(kind === "html" ? await htmlText(source) : source), truncated);
}

function toLines(text: string): string {
  return text
    .split(/\r\n?|\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function clamp(text: string, truncated: boolean): string | null {
  if (!text) return null;
  if (text.length <= EXCERPT_MAX_CHARS && !truncated) return text;
  let out = "";
  for (const { segment } of graphemes.segment(text)) {
    if (out.length + segment.length > EXCERPT_MAX_CHARS) break;
    out += segment;
  }
  if (out.length < text.length) {
    // Prefer ending on a word when one ends near the limit.
    const wordEnd = Math.max(out.lastIndexOf(" "), out.lastIndexOf("\n"));
    if (wordEnd > EXCERPT_MAX_CHARS * 0.8) out = out.slice(0, wordEnd);
  }
  out = out.trimEnd();
  return out ? `${out}…` : null;
}

// ─── Markdown ────────────────────────────────────────────────────────────────

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const FENCE = /^\s*(?:```|~~~)/;
const RULE_OR_UNDERLINE = /^\s*(?:(?:[-*_]\s*){3,}|=+\s*)$/;
const TABLE_SEPARATOR_CHARS = /^[\s|:-]*$/;
const REFERENCE_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*\S/;
const BLOCK_PREFIX = /^\s*(?:>\s?)*\s*(?:#{1,6}\s+|(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?)?/;

/** `cut`: an over-long line ended the text early. */
function markdownText(source: string): { text: string; cut: boolean } {
  const lines = replaceUntilStable(source.replace(FRONT_MATTER, ""), HTML_COMMENT).split(
    /\r\n?|\n/,
  );
  const long = lines.findIndex((line) => line.length > MARKDOWN_MAX_LINE);
  if (long !== -1) {
    lines.length = long + 1;
    lines[long] = lines[long]!.slice(0, MARKDOWN_MAX_LINE);
  }
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (RULE_OR_UNDERLINE.test(line) || isTableSeparator(line) || REFERENCE_DEFINITION.test(line)) {
      continue;
    }
    out.push(markdownInline(line.replace(BLOCK_PREFIX, "").trimEnd().replace(/\s#+$/, "")));
  }
  return { text: out.join("\n"), cut: long !== -1 };
}

function isTableSeparator(line: string): boolean {
  return line.includes("|") && line.includes("-") && TABLE_SEPARATOR_CHARS.test(line);
}

/** Apply `re` until nothing changes, so a removal cannot assemble a new match from its surroundings. */
function replaceUntilStable(text: string, re: RegExp): string {
  let prev: string;
  do {
    prev = text;
    text = text.replace(re, "");
  } while (text !== prev);
  return text;
}

function markdownInline(line: string): string {
  const stripped = replaceUntilStable(line, /<\/?[a-zA-Z][^<>]*>/g);
  return stripped
    .replace(/!\[([^[\]]*)\]\([^()]*\)/g, "$1")
    .replace(/\[([^[\]]*)\]\([^()]*\)/g, "$1")
    .replace(/\[([^[\]]+)\]\[[^[\]]*\]/g, "$1")
    .replace(/<((?:https?|mailto):[^<>\s]+)>/g, "$1")
    .replace(/(`+)([^`]+)\1/g, "$2")
    .replace(/(?<!\\)(\*{1,3})(?=\S)(.+?)(?<![\s\\])\1/g, "$2")
    .replace(/(?<![\w\\])(_{1,3})(?=\S)(.+?)(?<![\s\\])\1(?!\w)/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/(?<!\\)\|/g, " ")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1");
}

// ─── HTML ────────────────────────────────────────────────────────────────────

/** Elements whose text is never content: invisible, form controls, or (`title`) collected apart. */
const HIDDEN = "script, style, template, noscript, svg, title, button, select, textarea";
const BLOCKS =
  "address, article, aside, blockquote, br, dd, div, dl, dt, figcaption, figure, footer, " +
  "form, h1, h2, h3, h4, h5, h6, header, hr, li, main, nav, ol, p, pre, section, table, tr, ul";

async function htmlText(source: string): Promise<string> {
  let title = "";
  const body: string[] = [];
  let hidden = 0;
  await new HTMLRewriter()
    .on(HIDDEN, {
      element(el) {
        if (!el.canHaveContent) return;
        hidden++;
        el.onEndTag(() => {
          hidden--;
        });
      },
    })
    .on("title", {
      text(chunk) {
        // Depth 1 = the title element alone; deeper is an `<svg><title>`.
        if (hidden === 1) title += chunk.text;
      },
    })
    .on(BLOCKS, {
      element() {
        body.push("\n");
      },
    })
    .on("td, th", {
      element() {
        body.push(" ");
      },
    })
    .onDocument({
      text(chunk) {
        if (hidden === 0) body.push(chunk.text);
      },
    })
    .transform(new Response(source))
    .arrayBuffer();

  const heading = toLines(decodeEntities(title)).replace(/\n/g, " ");
  const lines = toLines(decodeEntities(body.join(""))).split("\n");
  // A page commonly repeats its `<title>` as (the start of) its first heading.
  if (heading && lines[0]?.toLowerCase().startsWith(heading.toLowerCase())) return lines.join("\n");
  return [heading, ...lines].join("\n");
}

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["hellip", "…"],
  ["mdash", "—"],
  ["ndash", "–"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["laquo", "«"],
  ["raquo", "»"],
  ["middot", "·"],
  ["bull", "•"],
  ["copy", "©"],
  ["reg", "®"],
  ["trade", "™"],
  ["euro", "€"],
  ["agrave", "à"],
  ["acirc", "â"],
  ["ccedil", "ç"],
  ["eacute", "é"],
  ["egrave", "è"],
  ["ecirc", "ê"],
  ["euml", "ë"],
  ["icirc", "î"],
  ["iuml", "ï"],
  ["ocirc", "ô"],
  ["ugrave", "ù"],
  ["ucirc", "û"],
  ["Eacute", "É"],
]);

/** Numeric references and a common subset of named ones; any other name stays as written. */
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g,
    (raw, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name) return NAMED_ENTITIES.get(name) ?? raw;
      const cp = dec ? Number(dec) : parseInt(hex!, 16);
      const valid = cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff);
      return valid ? String.fromCodePoint(cp) : "�";
    },
  );
}
