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

function member(files: Record<string, Uint8Array>, path: string): string | null {
  const bytes = files[path];
  return bytes ? utf8.decode(bytes) : null;
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

/** Stand-ins for the line and tab breaks the markup implies, outside any text run. */
const PARAGRAPH_BREAK = "\u0001";
const TAB_BREAK = "\u0002";

/** The text of a WordprocessingML / DrawingML fragment: runs concatenated, paragraphs on lines. */
function paragraphText(xml: string, textTag: string, paragraphTag: string): string {
  const marked = xml
    .replace(new RegExp(`</${paragraphTag}>`, "g"), PARAGRAPH_BREAK)
    .replace(/<w:br\s*\/>|<a:br\s*\/>/g, PARAGRAPH_BREAK)
    .replace(/<w:tab\s*\/>/g, TAB_BREAK)
    .replace(/<\/w:tc>/g, TAB_BREAK)
    .replace(/<\/w:tr>/g, PARAGRAPH_BREAK);
  const out: string[] = [];
  let inText = false;
  for (const match of marked.matchAll(/<(\/?)([A-Za-z0-9]+:[A-Za-z0-9]+)[^>]*?(\/?)>|([^<]+)/g)) {
    const [, closing, tag, selfClosing, text] = match;
    if (text !== undefined) {
      if (inText) out.push(decodeXml(text));
      else
        out.push(
          [...text].filter((char) => char === PARAGRAPH_BREAK || char === TAB_BREAK).join(""),
        );
      continue;
    }
    if (tag === textTag) inText = closing !== "/" && selfClosing !== "/";
  }
  return tidy(out.join("").replaceAll(PARAGRAPH_BREAK, "\n").replaceAll(TAB_BREAK, "\t"));
}

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

async function readPdf(bytes: Uint8Array, budget: TextBudget): Promise<{ units: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const units = pdf.numPages;
    for (let pageNumber = 1; pageNumber <= Math.min(units, PDF_MAX_PAGES); pageNumber++) {
      if (budget.full) break;
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
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((entry) =>
    decodeXml(
      [...entry[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((text) => text[1]).join(""),
    ),
  );
}

/** Sheet name + archive path, in workbook order. */
function workbookSheets(files: Record<string, Uint8Array>): { name: string; path: string }[] {
  const workbook = member(files, "xl/workbook.xml");
  const rels = member(files, "xl/_rels/workbook.xml.rels");
  if (workbook === null || rels === null) throw new Error("not an xlsx");
  const targets = new Map<string, string>();
  for (const rel of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]*)"/.exec(rel[1]!)?.[1];
    const target = /\bTarget="([^"]*)"/.exec(rel[1]!)?.[1];
    if (id && target) targets.set(id, target);
  }
  const sheets: { name: string; path: string }[] = [];
  for (const sheet of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = /\bname="([^"]*)"/.exec(sheet[1]!)?.[1];
    const rid = /\br:id="([^"]*)"/.exec(sheet[1]!)?.[1];
    const target = rid ? targets.get(rid) : undefined;
    if (name === undefined || !target) continue;
    sheets.push({
      name: decodeXml(name),
      path: target.startsWith("/") ? target.slice(1) : `xl/${target}`,
    });
  }
  return sheets;
}

/** Column letters of a cell reference (`AB12` → 27), 0-based. */
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
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attributes = cell[1]!;
        const body = cell[2] ?? "";
        const column = columnIndex(/\br="([A-Z]+\d+)"/.exec(attributes)?.[1] ?? "");
        if (column < 0 || column >= SHEET_MAX_COLUMNS) continue;
        const type = /\bt="([^"]*)"/.exec(attributes)?.[1];
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value = "";
        if (type === "s") value = raw === undefined ? "" : (strings[Number(raw)] ?? "");
        else if (type === "inlineStr")
          value = decodeXml(
            [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((text) => text[1]).join(""),
          );
        else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
        else if (raw !== undefined) value = decodeXml(raw);
        if (value === "") continue;
        while (cells.length < column) cells.push("");
        cells[column] = value.replace(/[\t\r\n]+/g, " ");
      }
      if (cells.some((cell) => cell !== "")) rows.push(cells.join("\t"));
    }
    budget.add(`--- Sheet: ${sheet.name} ---\n${rows.join("\n")}`);
  }
  return { units: sheets.length };
}

/** OpenDocument: `content.xml` carries the body of text, spreadsheet and presentation alike. */
function readOpenDocument(
  files: Record<string, Uint8Array>,
  format: "odt" | "ods" | "odp",
  budget: TextBudget,
): { units: number } {
  const xml = member(files, "content.xml");
  if (xml === null) throw new Error("not an OpenDocument file");
  const paragraphs = (fragment: string) =>
    tidy(
      decodeXml(
        fragment
          .replace(/<text:tab\s*\/>/g, "\t")
          .replace(/<text:line-break\s*\/>/g, "\n")
          .replace(/<text:s\b[^>]*\/>/g, " ")
          .replace(/<\/text:(?:p|h)>/g, "\n")
          .replace(/<[^>]+>/g, ""),
      ),
    );
  if (format === "odt") {
    budget.add(paragraphs(xml.slice(xml.indexOf("<office:text"))));
    return { units: 1 };
  }
  if (format === "odp") {
    const pages = [...xml.matchAll(/<draw:page\b[^>]*>([\s\S]*?)<\/draw:page>/g)];
    pages.forEach((page, index) => {
      if (!budget.full) budget.add(`--- Slide ${index + 1} ---\n${paragraphs(page[1]!)}`);
    });
    return { units: pages.length };
  }
  const tables = [...xml.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g)];
  for (const table of tables) {
    if (budget.full) break;
    const name = decodeXml(/\btable:name="([^"]*)"/.exec(table[1]!)?.[1] ?? "");
    const rows: string[] = [];
    for (const row of table[2]!.matchAll(
      /<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/g,
    )) {
      const cells = [
        ...row[1]!.matchAll(/<table:table-cell\b[^>]*?(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g),
      ]
        .slice(0, SHEET_MAX_COLUMNS)
        .map((cell) => paragraphs(cell[1] ?? "").replace(/\n+/g, " "));
      while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
      if (cells.length > 0) rows.push(cells.join("\t"));
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
): Promise<DocumentTextResult> {
  const budget = new TextBudget(maxChars);
  try {
    let units: number;
    if (format === "pdf") {
      ({ units } = await readPdf(bytes, budget));
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
    const truncated = budget.truncated || cutByPages;
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
  return documentTextCache.get(`${input.sha256}:${format}`, async () => {
    const bytes = await input.read();
    return bytes ? extract(bytes, format, DOCUMENT_TEXT_MAX_CHARS) : { status: "failed", format };
  });
}

/** Extraction with an explicit cap, uncached: the seam the unit tests drive. */
export function extractDocumentTextUncached(
  bytes: Uint8Array,
  format: DocumentFormat,
  maxChars = DOCUMENT_TEXT_MAX_CHARS,
): Promise<DocumentTextResult> {
  return extract(bytes, format, maxChars);
}
