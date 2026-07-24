// SPDX-License-Identifier: Apache-2.0

/**
 * MIME policy — the ONE declared-vs-sniffed magic-byte compatibility module,
 * shared by every ingestion path so the rules cannot drift between them:
 *
 *  - Staged-upload consume (`services/uploads.ts` → run workspace / durable doc)
 *  - Inline `data:` URI input (`services/input-parser.ts`)
 *  - Agent-output ingestion (`services/documents.ts` → `POST /runs/:id/documents`)
 *
 * Two enforcement *modes* consume the same policy, with a deliberate asymmetry:
 *
 *  - USER-supplied bytes (uploads, inline) → a declared/sniffed MISMATCH is a
 *    lie about the content and is REJECTED (the caller controls both the
 *    declaration and the bytes).
 *  - AGENT-produced bytes (run outputs) → the agent legitimately emits odd files
 *    and a strict declaration it did not think about; a mismatch is not rejected
 *    but the stored mime is RELABELLED to the sniffed one ({@link resolveAgentOutputMime})
 *    so the label stays honest and the preview/kind logic downstream stays safe.
 */

/** Strip charset / boundary / other parameters from a MIME string and lowercase it. */
export function normalizeMime(mime: string): string {
  return mime.split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * MIME prefixes/values where `file-type` cannot sniff a signature — these
 * formats have no magic bytes (plain text, JSON, CSV, XML source, JS, etc.).
 * For these we skip the sniff check and trust the declared mime. Callers
 * that need strict binary validation should declare a concrete binary MIME
 * (application/pdf, image/*, etc.) which `file-type` can identify.
 */
export function isUnsniffableMime(mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  // Structured text payloads with no reliable magic signature.
  const unsniffable = new Set([
    "application/json",
    "application/x-ndjson",
    "application/ld+json",
    "application/xml",
    "application/x-yaml",
    "application/yaml",
    "application/csv",
    "application/javascript",
    "application/ecmascript",
    "application/x-sh",
    "application/x-httpd-php",
    "application/x-www-form-urlencoded",
    "image/svg+xml", // XML-based, file-type never matches it
  ]);
  if (unsniffable.has(mime)) return true;
  // Structured-suffix convention (RFC 6839) — `+json`, `+xml`, `+yaml`.
  // Anything in these families is text-shaped and cannot be magic-sniffed.
  if (mime.endsWith("+json") || mime.endsWith("+xml") || mime.endsWith("+yaml")) return true;
  return false;
}

/**
 * MIMEs whose on-disk format is a ZIP container. `file-type` samples only the
 * head of the stream (~4100 bytes); when the identifying entry of an OOXML/ODF
 * archive ([Content_Types].xml, mimetype) sits beyond the sample window — the
 * normal layout for openpyxl/LibreOffice/Google-exported files — it falls back
 * to plain `application/zip`. Treating that fallback as a mismatch would
 * reject legitimate office documents, so declared-vs-sniffed comparison uses
 * Marcel/Tika-style subtype refinement: a declared member of this family is
 * compatible with a sniffed `application/zip` (and vice versa). A declaration
 * outside the family (application/pdf, image/png, …) still requires an exact
 * sniff match.
 */
const ZIP_CONTAINER_MIMES = new Set([
  // OOXML
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template", // xltx
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template", // dotx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // pptx
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow", // ppsx
  "application/vnd.openxmlformats-officedocument.presentationml.template", // potx
  // OOXML macro-enabled
  "application/vnd.ms-excel.sheet.macroenabled.12", // xlsm
  "application/vnd.ms-excel.template.macroenabled.12", // xltm
  "application/vnd.ms-word.document.macroenabled.12", // docm
  "application/vnd.ms-word.template.macroenabled.12", // dotm
  "application/vnd.ms-powerpoint.presentation.macroenabled.12", // pptm
  "application/vnd.ms-powerpoint.slideshow.macroenabled.12", // ppsm
  // OpenDocument
  "application/vnd.oasis.opendocument.text", // odt
  "application/vnd.oasis.opendocument.spreadsheet", // ods
  "application/vnd.oasis.opendocument.presentation", // odp
  "application/vnd.oasis.opendocument.graphics", // odg
  // Other ZIP-based formats
  "application/epub+zip",
  "application/java-archive", // jar
]);

/**
 * Legacy Office formats stored in an OLE2 / Compound File Binary container.
 * `file-type` identifies the container magic (`application/x-cfb`) but never
 * refines it to the concrete format, so every legitimate legacy Office upload
 * sniffs as the generic parent — same shape as the ZIP family above.
 */
const CFB_CONTAINER_MIMES = new Set([
  "application/msword", // .doc
  "application/vnd.ms-excel", // .xls
  "application/vnd.ms-powerpoint", // .ppt
  "application/vnd.ms-outlook", // .msg
  "application/vnd.visio", // .vsd
]);

/**
 * Container families for declared-vs-sniffed refinement: `generic` is the
 * parent MIME the sniffer reports for the raw container, `members` are the
 * concrete formats stored in it.
 */
const CONTAINER_FAMILIES: ReadonlyArray<{ generic: string; members: Set<string> }> = [
  { generic: "application/zip", members: ZIP_CONTAINER_MIMES },
  { generic: "application/x-cfb", members: CFB_CONTAINER_MIMES },
];

/**
 * Declared-vs-sniffed MIME compatibility for the magic-byte check. Exact match
 * always passes; otherwise refinement is strictly parent↔child against a
 * container family's generic type (declared xlsx / sniffed application/zip,
 * declared application/zip / sniffed xlsx). Two SPECIFIC container types never
 * satisfy each other — declared xlsx with sniffed docm/xlsm stays a mismatch,
 * so a macro-enabled document cannot ride in under a macro-free declaration
 * when the sniffer DID identify it. Exact-match outside the families requires
 * the sniffed value to equal the declared one.
 */
export function sniffedMimeMatchesDeclared(declared: string, sniffed: string | undefined): boolean {
  if (!sniffed) return false;
  if (sniffed === declared) return true;
  for (const { generic, members } of CONTAINER_FAMILIES) {
    if (sniffed === generic && members.has(declared)) return true;
    if (declared === generic && members.has(sniffed)) return true;
  }
  return false;
}

/**
 * Whether a declared MIME should be magic-byte enforced at all. Two escape
 * hatches skip the sniff check: `application/octet-stream` (the explicit "any
 * blob" marker) and text-ish MIMEs ({@link isUnsniffableMime}) which have no
 * signature `file-type` can read. One predicate so every user-input path (upload
 * consume, inline data URI) gates the strict check identically.
 */
export function shouldEnforceSniffedMime(declared: string): boolean {
  return declared !== "" && declared !== "application/octet-stream" && !isUnsniffableMime(declared);
}

/**
 * The mime an AGENT-produced document should be STORED under. Agent outputs are
 * never rejected on a mismatch (an agent legitimately emits a PNG under a
 * `text/plain` Content-Type it never thought about); instead the label is made
 * honest: when the bytes sniff to a concrete type that does not match the
 * declared one, the sniffed type wins (relabel). When the sniffer cannot read
 * the bytes (text-ish / unknown), or the declared type is already compatible,
 * the declared mime is kept. This keeps the downstream preview/kind logic safe
 * without ever failing an agent's publish. Returns the normalized mime to store.
 */
export function resolveAgentOutputMime(declared: string, sniffed: string | undefined): string {
  const declaredNorm = normalizeMime(declared);
  if (!sniffed) return declaredNorm;
  const sniffedNorm = normalizeMime(sniffed);
  if (sniffedMimeMatchesDeclared(declaredNorm, sniffedNorm)) return declaredNorm;
  // Genuine mismatch with a concrete sniffed type — relabel to the truth.
  return sniffedNorm;
}
