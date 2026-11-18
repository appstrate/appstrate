// SPDX-License-Identifier: Apache-2.0

/**
 * The text of a document file, for a model that reads text only.
 *
 * A PDF or an Office file reaches a model as the words it holds, never as its
 * bytes: base64 of a binary is useless to a model and costs the context window
 * it fills. This is the one reader behind `read_file` and `resources/read` on an
 * `appfile://` (`modules/mcp/tools.ts`), applied at read time and cached by the
 * file's `sha256` (a content hash: immutable, so the entry needs no
 * invalidation).
 *
 * Pure JavaScript on purpose: the platform image carries no `pdftotext`, and a
 * second runtime to install and sandbox is a worse trade than a library. PDF
 * text comes from pdf.js through `unpdf` (Apache-2.0 / MIT); Office and
 * OpenDocument files are ZIPs of XML read with the platform's bounded unzip, so a
 * decompression bomb is refused while it inflates, not after.
 *
 * What it does not do, by design: OCR (a scanned PDF answers {@link DocumentTextResult}
 * `empty`, and the caller says so), the legacy binary Office formats (`.doc`,
 * `.xls`, `.ppt`), formulas (an `.xlsx` cell yields the value its last save
 * cached), comments, tracked changes, images and charts.
 */

import { createCache } from "@appstrate/core/cache";
import { DecompressionLimitError, unzipBounded } from "@appstrate/core/zip";
import { getDocumentProxy } from "unpdf";
import { logger } from "../lib/logger.ts";

export type DocumentFormat = "pdf" | "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp";

/** The unit a format is divided in, for the markers and the truncation note. */
const UNIT: Record<DocumentFormat, string> = {
  pdf: "page",
  docx: "document",
  xlsx: "sheet",
  pptx: "slide",
  odt: "document",
  ods: "sheet",
  odp: "slide",
};

const MIME_FORMAT: Record<string, DocumentFormat> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
};

/** A generic or missing MIME is judged by the extension, as browsers send `application/octet-stream` for many. */
const EXTENSION_FORMAT: Record<string, DocumentFormat> = {
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  odt: "odt",
  ods: "ods",
  odp: "odp",
};

/**
 * Stored size above which a file is not opened: the cost of unpacking it is the
 * platform's, and the text of a file this large would be cut anyway.
 */
export const DOCUMENT_SOURCE_MAX_BYTES = 25 * 1024 * 1024;
/** Characters of extracted text one read returns (about 30k tokens); the rest is cut with a note. */
const DOCUMENT_TEXT_MAX_CHARS = 120_000;
/** Pages of a PDF read at most, whatever the text cap, so a thousand-page scan costs bounded CPU. */
const PDF_MAX_PAGES = 300;
/** Decompressed bytes an Office/ODF archive may inflate to, in total and per member. */
const ZIP_LIMITS = {
  maxDecompressedBytes: 64 * 1024 * 1024,
  maxFileBytes: 32 * 1024 * 1024,
  maxFiles: 5_000,
};
/**
 * Wall time a PDF may spend before the pages read so far are returned. pdf.js runs on the API's
 * event loop, so it is checked between pages: one page whose content stream is itself hostile is
 * not interruptible here, which a worker would fix (the known limit of this reader).
 */
const PDF_TIME_BUDGET_MS = 20_000;
/** PDFs read at once: the rest wait, so a burst of them cannot monopolize the event loop. */
const PDF_MAX_CONCURRENT = 2;
/** Cells of one spreadsheet row kept: a wider row is a layout artifact, not data a model reads. */
const SHEET_MAX_COLUMNS = 100;

export type DocumentTextResult =
  /** Text was extracted; `truncated` says the cap cut it, `note` states it for the model. */
  | { status: "text"; text: string; format: DocumentFormat; truncated: boolean; note?: string }
  /** The file is a document of a supported format that holds no text (a scan, an empty sheet). */
  | { status: "empty"; format: DocumentFormat }
  /** The file is not a supported document, or is over {@link DOCUMENT_SOURCE_MAX_BYTES}. */
  | { status: "unsupported"; reason: "format" | "too_large" }
  /** The file claims a supported format but does not parse (corrupt, encrypted, a bomb). */
  | { status: "failed"; format: DocumentFormat };

/** The format of a file by MIME, else by extension; `null` when it is not a supported document. */
export function documentFormatOf(mime: string, name?: string | null): DocumentFormat | null {
  const byMime = MIME_FORMAT[mime.split(";")[0]!.trim().toLowerCase()];
  if (byMime) return byMime;
  const extension = name?.split(".").pop()?.toLowerCase();
  return extension ? (EXTENSION_FORMAT[extension] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Output budget
// ---------------------------------------------------------------------------

const SECTION_SEPARATOR = "\n\n";

/** Accumulates sections until the character cap, then refuses more. */
class TextBudget {
  private readonly parts: string[] = [];
  private used = 0;
  /** Units (pages, sheets, slides) fully or partly written. */
  written = 0;
  truncated = false;

  constructor(private readonly max: number) {}

  /** Append one section; the one that crosses the cap is cut, the next ones are dropped. */
  add(section: string): void {
    if (this.truncated) return;
    // The blank line `text` puts between sections counts against the cap too.
    const separator = this.parts.length > 0 ? SECTION_SEPARATOR.length : 0;
    const room = this.max - this.used - separator;
    if (section.length <= room) {
      this.parts.push(section);
      this.used += separator + section.length;
      this.written += 1;
      return;
    }
    if (room > 0) {
      this.parts.push(section.slice(0, room));
      this.used += separator + room;
      this.written += 1;
    }
    this.truncated = true;
  }

  /** Stop here for a reason other than the character cap (the time limit): the output is truncated. */
  cut(): void {
    this.truncated = true;
  }

  get full(): boolean {
    return this.truncated || this.used >= this.max;
  }

  get text(): string {
    return this.parts.join(SECTION_SEPARATOR).trim();
  }
}

// ---------------------------------------------------------------------------
// XML helpers (the formats below are read with patterns, not a DOM: the files
// are bounded, the tags read are few and the text is all that is wanted)
// ---------------------------------------------------------------------------

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith("#x")) return safeCodePoint(parseInt(entity.slice(2), 16), whole);
    if (entity.startsWith("#")) return safeCodePoint(parseInt(entity.slice(1), 10), whole);
    return XML_ENTITIES[entity] ?? whole;
  });
}

function safeCodePoint(code: number, fallback: string): string {
  try {
    return Number.isFinite(code) ? String.fromCodePoint(code) : fallback;
  } catch {
    return fallback;
  }
}

const utf8 = new TextDecoder("utf-8");

/**
 * Inflated bytes one content XML member may weigh. The unzip bounds the archive as a whole; this is
 * the bound on what the scans below read, so a 30 MiB `sheet1.xml` is refused, not walked.
 */
const XML_MEMBER_MAX_BYTES = 16 * 1024 * 1024;

function member(files: Record<string, Uint8Array>, path: string): string | null {
  const bytes = files[path];
  if (!bytes) return null;
  if (bytes.byteLength > XML_MEMBER_MAX_BYTES) throw new Error("content member too large");
  return utf8.decode(bytes);
}

/** The numeric suffix of `…/slide12.xml`, for natural ordering. */
function ordinal(path: string): number {
  return Number(/(\d+)\.xml$/.exec(path)?.[1] ?? 0);
}

/** Collapse runs of blanks inside a line and blank lines between paragraphs. */
function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Walk markup left to right, one `indexOf` per `<` and per `>`: every byte is looked at a bounded
 * number of times, whatever the input. A document is untrusted and the scan runs on the API's
 * event loop, so nothing here may backtrack: a pattern like `<c\b[^>]*>[\s\S]*?</c>` rescans to the
 * end of the string from every opening tag that is never closed, which is quadratic (80 000 unclosed
 * tags took 10 s). A tag that is never terminated ends the walk.
 */
function walkMarkup(
  xml: string,
  onText: (text: string) => void,
  onTag: (name: string, closing: boolean, selfClosing: boolean) => void,
): void {
  let position = 0;
  while (position < xml.length) {
    const open = xml.indexOf("<", position);
    if (open === -1) {
      onText(xml.slice(position));
      return;
    }
    if (open > position) onText(xml.slice(position, open));
    const close = xml.indexOf(">", open + 1);
    if (close === -1) return;
    const inner = xml.slice(open + 1, close);
    const closing = inner.startsWith("/");
    const selfClosing = inner.endsWith("/");
    const start = closing ? 1 : 0;
    let end = start;
    while (end < inner.length && !/[\s/]/.test(inner[end]!)) end += 1;
    onTag(inner.slice(start, end), closing, selfClosing);
    position = close + 1;
  }
}

/**
 * The elements named `name`, in order, with their attribute text and body. Linear for the reason
 * given at {@link walkMarkup}: each search starts where the previous element ended, and an element
 * that is never closed ends the scan instead of being searched for again from the next opening tag.
 * Elements do not nest here (the same tag inside itself closes at the first end tag).
 */
function* elements(xml: string, name: string): Generator<{ attributes: string; body: string }> {
  const open = `<${name}`;
  const end = `</${name}>`;
  let position = 0;
  while (position < xml.length) {
    const start = xml.indexOf(open, position);
    if (start === -1) return;
    const after = start + open.length;
    // `<c` must not match `<col`: the name ends at a blank, `>` or `/`.
    if (!/[\s>/]/.test(xml[after] ?? "")) {
      position = after;
      continue;
    }
    const close = xml.indexOf(">", after);
    if (close === -1) return;
    const attributes = xml.slice(after, close);
    if (attributes.endsWith("/")) {
      yield { attributes: attributes.slice(0, -1), body: "" };
      position = close + 1;
      continue;
    }
    const stop = xml.indexOf(end, close + 1);
    if (stop === -1) return;
    yield { attributes, body: xml.slice(close + 1, stop) };
    position = stop + end.length;
  }
}

/** The concatenated bodies of the `<t>` runs of `fragment`. */
function runsText(fragment: string, tag = "t"): string {
  let text = "";
  for (const run of elements(fragment, tag)) text += run.body;
  return decodeXml(text);
}

/** One attribute's value, from an element's attribute text. */
const attributePatterns = new Map<string, RegExp>();

function attribute(attributes: string, name: string): string | undefined {
  let pattern = attributePatterns.get(name);
  if (!pattern) {
    pattern = new RegExp(`(?:^|\\s)${name.replace(/[:.]/g, "\\$&")}="([^"]*)"`);
    attributePatterns.set(name, pattern);
  }
  return pattern.exec(attributes)?.[1];
}

/** The text of a WordprocessingML / DrawingML fragment: runs concatenated, paragraphs on lines. */
function paragraphText(xml: string, textTag: string, paragraphTag: string): string {
  const out: string[] = [];
  let inText = false;
  walkMarkup(
    xml,
    (text) => {
      if (inText) out.push(decodeXml(text));
    },
    (name, closing, selfClosing) => {
      if (name === textTag) inText = !closing && !selfClosing;
      else if (closing && (name === paragraphTag || name === "w:tr")) out.push("\n");
      else if (!closing && (name === "w:br" || name === "a:br")) out.push("\n");
      else if (!closing && name === "w:tab") out.push("\t");
      else if (closing && name === "w:tc") out.push("\t");
    },
  );
  return tidy(out.join(""));
}

/** At most `limit` of the functions passed to the returned `run` are in flight; the others queue. */
export function createGate(limit: number): <T>(work: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (work) => {
    // A waiter is handed the slot of the one that finished, so a caller arriving in between
    // cannot take it and push the count past the limit.
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

const pdfGate = createGate(PDF_MAX_CONCURRENT);

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

async function readPdf(
  bytes: Uint8Array,
  budget: TextBudget,
  timeBudgetMs: number,
): Promise<{ units: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const units = pdf.numPages;
    const started = performance.now();
    for (let pageNumber = 1; pageNumber <= Math.min(units, PDF_MAX_PAGES); pageNumber++) {
      if (budget.full) break;
      if (pageNumber > 1 && performance.now() - started > timeBudgetMs) {
        budget.cut();
        break;
      }
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = tidy(
        content.items
          .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
          .join(""),
      );
      // A page with no text (an image) is still a page: its marker tells the model so.
      budget.add(`--- Page ${pageNumber} ---\n${text}`);
    }
    return { units };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

function readDocx(files: Record<string, Uint8Array>, budget: TextBudget): { units: number } {
  const xml = member(files, "word/document.xml");
  if (xml === null) throw new Error("not a docx");
  budget.add(paragraphText(xml, "w:t", "w:p"));
  return { units: 1 };
}

function readPptx(files: Record<string, Uint8Array>, budget: TextBudget): { units: number } {
  const slides = Object.keys(files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => ordinal(a) - ordinal(b));
  if (slides.length === 0) throw new Error("not a pptx");
  slides.forEach((path, index) => {
    if (budget.full) return;
    const slide = paragraphText(member(files, path)!, "a:t", "a:p");
    const notesXml = member(files, `ppt/notesSlides/notesSlide${ordinal(path)}.xml`);
    const notes = notesXml ? paragraphText(notesXml, "a:t", "a:p") : "";
    budget.add(
      `--- Slide ${index + 1} ---\n${slide}${notes ? `\n\nSpeaker notes:\n${notes}` : ""}`,
    );
  });
  return { units: slides.length };
}

/** `<si>` entries of `xl/sharedStrings.xml`, the text a string cell points at by index. */
function sharedStrings(files: Record<string, Uint8Array>): string[] {
  const xml = member(files, "xl/sharedStrings.xml");
  if (xml === null) return [];
  // One string may be referenced by thousands of cells: each is cut to the output cap once.
  return [...elements(xml, "si")].map((entry) =>
    runsText(entry.body).slice(0, DOCUMENT_TEXT_MAX_CHARS),
  );
}

/** Sheet name + archive path, in workbook order. */
function workbookSheets(files: Record<string, Uint8Array>): { name: string; path: string }[] {
  const workbook = member(files, "xl/workbook.xml");
  const rels = member(files, "xl/_rels/workbook.xml.rels");
  if (workbook === null || rels === null) throw new Error("not an xlsx");
  const targets = new Map<string, string>();
  for (const rel of elements(rels, "Relationship")) {
    const id = attribute(rel.attributes, "Id");
    const target = attribute(rel.attributes, "Target");
    if (id && target) targets.set(id, target);
  }
  const sheets: { name: string; path: string }[] = [];
  for (const sheet of elements(workbook, "sheet")) {
    const name = attribute(sheet.attributes, "name");
    const rid = attribute(sheet.attributes, "r:id");
    const target = rid ? targets.get(rid) : undefined;
    if (name === undefined || !target) continue;
    sheets.push({
      name: decodeXml(name),
      path: target.startsWith("/") ? target.slice(1) : `xl/${target}`,
    });
  }
  return sheets;
}

/** Column letters of a cell reference (`AB12` → 27), 0-based; -1 for none. */
function columnIndex(reference: string): number {
  let index = 0;
  for (const char of /^[A-Z]+/.exec(reference)?.[0] ?? "")
    index = index * 26 + char.charCodeAt(0) - 64;
  return index - 1;
}

function readXlsx(files: Record<string, Uint8Array>, budget: TextBudget): { units: number } {
  const sheets = workbookSheets(files);
  const strings = sharedStrings(files);
  for (const sheet of sheets) {
    if (budget.full) break;
    const xml = member(files, sheet.path);
    if (xml === null) continue;
    const rows: string[] = [];
    let rowChars = 0;
    for (const row of elements(xml, "row")) {
      // Enough rows to fill the budget: the rest would be cut, so it is not read.
      if (rowChars > DOCUMENT_TEXT_MAX_CHARS) break;
      const cells: string[] = [];
      // `r` is optional in SpreadsheetML: a cell without one sits right after the previous cell.
      let nextColumn = 0;
      let lineChars = 0;
      for (const cell of elements(row.body, "c")) {
        // The row is cut at the output cap while it is built: a cell referencing a long shared
        // string many times over would otherwise assemble megabytes before the cap is looked at.
        if (lineChars > DOCUMENT_TEXT_MAX_CHARS) break;
        const reference = attribute(cell.attributes, "r");
        const declared = reference === undefined ? -1 : columnIndex(reference);
        const column = declared >= 0 ? declared : nextColumn;
        nextColumn = column + 1;
        if (column >= SHEET_MAX_COLUMNS) continue;
        const type = attribute(cell.attributes, "t");
        const raw = [...elements(cell.body, "v")][0]?.body;
        let value = "";
        if (type === "s") value = raw === undefined ? "" : (strings[Number(raw)] ?? "");
        else if (type === "inlineStr") value = runsText(cell.body);
        else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
        else if (raw !== undefined) value = decodeXml(raw);
        if (value === "") continue;
        while (cells.length < column) cells.push("");
        cells[column] = value.replace(/[\t\r\n]+/g, " ");
        lineChars += cells[column].length + 1;
      }
      if (cells.some((cell) => cell !== "")) {
        const line = cells.join("\t");
        rows.push(line);
        rowChars += line.length + 1;
      }
    }
    budget.add(`--- Sheet: ${sheet.name} ---\n${rows.join("\n")}`);
  }
  return { units: sheets.length };
}

/** The text of an OpenDocument fragment: paragraphs on lines, the tab, break and space elements as such. */
function openDocumentText(fragment: string): string {
  const out: string[] = [];
  walkMarkup(
    fragment,
    (text) => out.push(text),
    (name, closing) => {
      if (closing) {
        if (name === "text:p" || name === "text:h") out.push("\n");
      } else if (name === "text:tab") out.push("\t");
      else if (name === "text:line-break") out.push("\n");
      else if (name === "text:s") out.push(" ");
    },
  );
  return tidy(decodeXml(out.join("")));
}

/** OpenDocument: `content.xml` carries the body of text, spreadsheet and presentation alike. */
function readOpenDocument(
  files: Record<string, Uint8Array>,
  format: "odt" | "ods" | "odp",
  budget: TextBudget,
): { units: number } {
  const xml = member(files, "content.xml");
  if (xml === null) throw new Error("not an OpenDocument file");
  if (format === "odt") {
    const body = xml.indexOf("<office:text");
    budget.add(openDocumentText(body === -1 ? xml : xml.slice(body)));
    return { units: 1 };
  }
  if (format === "odp") {
    const pages = [...elements(xml, "draw:page")];
    pages.forEach((page, index) => {
      if (!budget.full) budget.add(`--- Slide ${index + 1} ---\n${openDocumentText(page.body)}`);
    });
    return { units: pages.length };
  }
  const tables = [...elements(xml, "table:table")];
  for (const table of tables) {
    if (budget.full) break;
    const name = decodeXml(attribute(table.attributes, "table:name") ?? "");
    const rows: string[] = [];
    let rowChars = 0;
    for (const row of elements(table.body, "table:table-row")) {
      if (rowChars > DOCUMENT_TEXT_MAX_CHARS) break;
      const cells = [...elements(row.body, "table:table-cell")]
        .slice(0, SHEET_MAX_COLUMNS)
        .map((cell) => openDocumentText(cell.body).replace(/\n+/g, " "));
      while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
      if (cells.length > 0) {
        const line = cells.join("\t");
        rows.push(line);
        rowChars += line.length + 1;
      }
    }
    budget.add(`--- Sheet: ${name} ---\n${rows.join("\n")}`);
  }
  return { units: tables.length };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The extraction itself, without the cache. Never throws: a file that does not parse is `failed`. */
async function extract(
  bytes: Uint8Array,
  format: DocumentFormat,
  maxChars: number,
  pdfTimeBudgetMs = PDF_TIME_BUDGET_MS,
): Promise<DocumentTextResult> {
  const budget = new TextBudget(maxChars);
  try {
    let units: number;
    if (format === "pdf") {
      ({ units } = await pdfGate(() => readPdf(bytes, budget, pdfTimeBudgetMs)));
    } else {
      const files = unzipBounded(bytes, ZIP_LIMITS);
      if (format === "docx") ({ units } = readDocx(files, budget));
      else if (format === "pptx") ({ units } = readPptx(files, budget));
      else if (format === "xlsx") ({ units } = readXlsx(files, budget));
      else ({ units } = readOpenDocument(files, format, budget));
    }
    const text = budget.text
      .replace(/---\s(?:Page|Slide)\s\d+\s---|--- Sheet:[^\n]*---/g, "")
      .trim();
    if (text === "") return { status: "empty", format };

    const unit = UNIT[format];
    const cutByPages = format === "pdf" && units > PDF_MAX_PAGES;
    // The cap can be reached exactly, with nothing cut inside a unit but units left unread: that is
    // a truncation too, and it must say so.
    const truncated = budget.truncated || cutByPages || (budget.full && budget.written < units);
    const note = truncated
      ? units > 1
        ? `Truncated: the text of ${budget.written} of ${units} ${unit}s is shown (the first ${DOCUMENT_TEXT_MAX_CHARS.toLocaleString("en-US")} characters at most).`
        : `Truncated at ${DOCUMENT_TEXT_MAX_CHARS.toLocaleString("en-US")} characters.`
      : undefined;
    return { status: "text", text: budget.text, format, truncated, ...(note ? { note } : {}) };
  } catch (error) {
    // Never log the content or the error text of a user's file: its format and kind of failure only.
    logger.warn("document text extraction failed", {
      format,
      reason: error instanceof DecompressionLimitError ? error.reason : "unreadable",
    });
    return { status: "failed", format };
  }
}

/** Extractions by content hash: a hash names its bytes forever, so an entry is never stale. */
const documentTextCache = createCache<DocumentTextResult>({
  name: "document-text",
  ttlMs: 10 * 60_000,
  max: 32,
});

/**
 * The text of a document the caller already holds the bytes of. `sha256` keys
 * the cache; pass the stored file's hash (it identifies the bytes, not the
 * caller, and the ACL was judged before the bytes were read).
 */
export async function extractDocumentText(input: {
  sha256: string;
  mime: string;
  name?: string | null;
  size: number;
  read: () => Promise<Uint8Array | null>;
}): Promise<DocumentTextResult> {
  const format = documentFormatOf(input.mime, input.name);
  if (!format) return { status: "unsupported", reason: "format" };
  if (input.size > DOCUMENT_SOURCE_MAX_BYTES) return { status: "unsupported", reason: "too_large" };
  // A body that cannot be read (the storage object is momentarily gone) answers `undefined` from
  // the loader, which the cache answers but never stores: a transient miss must not read as
  // "corrupt" to every reader of the same content for the next ten minutes.
  const extracted = await documentTextCache.get(`${input.sha256}:${format}`, async () => {
    const bytes = await input.read();
    return bytes ? extract(bytes, format, DOCUMENT_TEXT_MAX_CHARS) : undefined;
  });
  return extracted ?? { status: "failed", format };
}

/** Extraction with an explicit cap, uncached: the seam the unit tests drive. */
export function extractDocumentTextUncached(
  bytes: Uint8Array,
  format: DocumentFormat,
  maxChars = DOCUMENT_TEXT_MAX_CHARS,
  pdfTimeBudgetMs?: number,
): Promise<DocumentTextResult> {
  return extract(bytes, format, maxChars, pdfTimeBudgetMs);
}
