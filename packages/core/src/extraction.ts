// SPDX-License-Identifier: Apache-2.0

/**
 * Bytes → text extraction — a platform BRIDGE primitive.
 *
 * "Turn an uploaded document into text" is not a search-internal detail: it
 * sits between `storage` (the bytes) and whoever needs the text. Two real
 * consumers justify hosting it in core rather than inside one module:
 *
 *   - `module-search` ingestion (extract → chunk → embed → index), and
 *   - the chat token-budget router (a small attachment read straight into the
 *     conversation, NEVER indexed) — the path that bypasses search entirely.
 *
 * The SURFACE is the stable contract (`extractText`); the ENGINE behind it is
 * deliberately swappable. v1 ships the proven lean engine
 * (`unpdf` for digital PDFs + a UTF-8 decode for text-like types). A richer
 * engine (e.g. liteparse: docx/pptx/xlsx + OCR) drops in behind this same
 * signature later, once its native-dependency / Bun compatibility is de-risked
 * — no caller changes.
 *
 * Everything runs in-process: a document's bytes never leave the instance.
 * `unpdf` is dynamically imported the first time a PDF is seen, so importing
 * this module (or extracting a text file) never loads pdf.js.
 */

/** PDF: by MIME, or by extension when the MIME is missing/generic. */
function isPdf(mime: string | null, name?: string): boolean {
  if (mime === "application/pdf") return true;
  return !mime || mime === "application/octet-stream"
    ? (name?.toLowerCase().endsWith(".pdf") ?? false)
    : false;
}

// Text-like families decoded as UTF-8: text/*, plus the common structured
// text types that carry no binary framing (JSON, XML, JS, CSV, …). Office
// containers (docx/pptx/xlsx) are NOT here — they are zipped XML and need a
// real parser (the post-v1 engine swap).
const TEXT_LIKE_MIME =
  /^text\/|^application\/(json|xml|x-ndjson|yaml|x-yaml|javascript|x-sh|x-www-form-urlencoded)\b/i;
const TEXT_LIKE_EXT =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|ndjson|xml|ya?ml|html?|css|js|ts|tsx|jsx|py|rb|go|rs|java|c|cc|cpp|h|sh|sql|log|ini|toml|cfg)$/i;

function isTextLike(mime: string | null, name?: string): boolean {
  if (mime && TEXT_LIKE_MIME.test(mime)) return true;
  // A generic/missing MIME with a known text extension still reads as text.
  return (!mime || mime === "application/octet-stream") && name?.match(TEXT_LIKE_EXT) != null;
}

/** Collapse runs of 3+ whitespace to a single newline; trim. Shared cleanup. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s{3,}/g, "\n").trim();
}

async function extractPdf(bytes: Uint8Array): Promise<string | null> {
  // Lazy import: pdf.js loads only when a PDF is actually extracted.
  const { extractText: pdfExtractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await pdfExtractText(pdf, { mergePages: true });
  const cleaned = normalizeWhitespace(text);
  return cleaned.length > 0 ? cleaned : null;
}

function extractTextLike(bytes: Uint8Array): string | null {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const cleaned = decoded.trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Extract the text of a document by its bytes + MIME (and optional name, used
 * to disambiguate a missing/generic MIME by extension).
 *
 * Returns `null` — never throws for "nothing to index" — when the type is
 * unsupported in v1, or when a recognized type yields no extractable text
 * (a scanned/image-only PDF, an empty file). Callers treat `null` as "skip,
 * not retry" rather than indexing empty noise. Real engine failures (a
 * corrupt PDF) still throw.
 */
export async function extractText(
  bytes: Uint8Array,
  mime: string | null,
  name?: string,
): Promise<string | null> {
  if (isPdf(mime, name)) return extractPdf(bytes);
  if (isTextLike(mime, name)) return extractTextLike(bytes);
  return null;
}
