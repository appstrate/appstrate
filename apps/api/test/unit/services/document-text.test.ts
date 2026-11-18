// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { pdfBytes as pdf } from "../../helpers/pdf.ts";
import {
  documentFormatOf,
  extractDocumentText,
  extractDocumentTextUncached,
  createGate,
  DOCUMENT_SOURCE_MAX_BYTES,
} from "../../../src/services/document-text.ts";

const zip = (entries: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(entries).map(([path, xml]) => [path, strToU8(xml)])));

describe("documentFormatOf", () => {
  it("reads the MIME, then the extension for a generic MIME", () => {
    expect(documentFormatOf("application/pdf")).toBe("pdf");
    expect(documentFormatOf("application/octet-stream", "rapport.XLSX")).toBe("xlsx");
    expect(documentFormatOf("text/plain", "notes.txt")).toBeNull();
    // The legacy binary Office formats are not read.
    expect(documentFormatOf("application/msword", "old.doc")).toBeNull();
  });
});

describe("extractDocumentTextUncached", () => {
  it("reads a PDF page by page, with page markers", async () => {
    const result = await extractDocumentTextUncached(
      pdf(["Hello first page", "Second page"]),
      "pdf",
    );
    expect(result).toMatchObject({ status: "text", format: "pdf", truncated: false });
    const text = (result as { text: string }).text;
    expect(text).toContain("--- Page 1 ---");
    expect(text).toContain("Hello first page");
    expect(text).toContain("--- Page 2 ---\nSecond page");
  });

  it("answers `empty` for a PDF with no text layer (a scan)", async () => {
    expect(await extractDocumentTextUncached(pdf(["", ""]), "pdf")).toEqual({
      status: "empty",
      format: "pdf",
    });
  });

  it("fails cleanly on bytes that are not the format they claim", async () => {
    expect(await extractDocumentTextUncached(strToU8("not a pdf"), "pdf")).toEqual({
      status: "failed",
      format: "pdf",
    });
    expect(await extractDocumentTextUncached(strToU8("not a zip"), "docx")).toEqual({
      status: "failed",
      format: "docx",
    });
  });

  it("reads a docx: paragraphs, tabs, table cells and entities", async () => {
    const document = `<w:document><w:body>
      <w:p><w:r><w:t>Titre &amp; suite</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">Un </w:t></w:r><w:r><w:t>paragraphe</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    </w:body></w:document>`;
    const result = await extractDocumentTextUncached(
      zip({ "word/document.xml": document }),
      "docx",
    );
    expect(result).toMatchObject({ status: "text", format: "docx" });
    const text = (result as { text: string }).text;
    expect(text).toContain("Titre & suite");
    expect(text).toContain("Un paragraphe");
    expect(text).toMatch(/A1\s+B1/);
    expect(text).not.toContain("<");
  });

  it("reads an xlsx: shared strings, numbers, inline strings, sparse columns, sheet names", async () => {
    const result = await extractDocumentTextUncached(
      zip({
        "xl/workbook.xml": `<workbook><sheets><sheet name="Ventes" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; co" sheetId="2" r:id="rId2"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
        "xl/sharedStrings.xml": `<sst><si><t>Produit</t></si><si><r><t>Mon</t></r><r><t>tant</t></r></si></sst>`,
        "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
          <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
          <row r="2"><c r="A2" t="inlineStr"><is><t>Stylo</t></is></c><c r="C2"><v>12.5</v></c></row>
        </sheetData></worksheet>`,
        "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="b"><v>1</v></c></row></sheetData></worksheet>`,
      }),
      "xlsx",
    );
    const text = (result as { text: string }).text;
    expect(text).toContain("--- Sheet: Ventes ---");
    expect(text).toContain("Produit\t\tMontant");
    expect(text).toContain("Stylo\t\t12.5");
    expect(text).toContain("--- Sheet: Notes & co ---\nTRUE");
  });

  it("reads an xlsx whose cells carry no `r` attribute, one after the other", async () => {
    const result = await extractDocumentTextUncached(
      zip({
        "xl/workbook.xml": `<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
        "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
          <row><c t="inlineStr"><is><t>a</t></is></c><c t="inlineStr"><is><t>b</t></is></c></row>
          <row><c r="C2"><v>3</v></c><c><v>4</v></c></row>
        </sheetData></worksheet>`,
      }),
      "xlsx",
    );
    expect((result as { text: string }).text).toContain("a\tb\n\t\t3\t4");
  });

  it("reads a pptx in slide order, with speaker notes", async () => {
    const slide = (text: string) => `<p:sld><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`;
    const result = await extractDocumentTextUncached(
      zip({
        "ppt/slides/slide10.xml": slide("Dixième"),
        "ppt/slides/slide2.xml": slide("Deuxième"),
        "ppt/slides/slide1.xml": slide("Première"),
        "ppt/notesSlides/notesSlide2.xml": slide("Dire bonjour"),
      }),
      "pptx",
    );
    const text = (result as { text: string }).text;
    expect(text.indexOf("Première")).toBeLessThan(text.indexOf("Deuxième"));
    expect(text.indexOf("Deuxième")).toBeLessThan(text.indexOf("Dixième"));
    expect(text).toContain("Speaker notes:\nDire bonjour");
  });

  it("reads OpenDocument text and spreadsheet", async () => {
    const odt = await extractDocumentTextUncached(
      zip({
        "content.xml": `<doc><office:body><office:text><text:h>Titre</text:h><text:p>Une <text:s/>ligne</text:p></office:text></office:body></doc>`,
      }),
      "odt",
    );
    expect((odt as { text: string }).text).toBe("Titre\nUne ligne");

    const ods = await extractDocumentTextUncached(
      zip({
        "content.xml": `<doc><table:table table:name="Feuille1"><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table></doc>`,
      }),
      "ods",
    );
    expect((ods as { text: string }).text).toContain("--- Sheet: Feuille1 ---\na\tb");
  });

  it("cuts at the cap with a note naming how much is shown", async () => {
    const result = await extractDocumentTextUncached(
      pdf(["alpha alpha alpha", "bravo bravo bravo", "charlie charlie"]),
      "pdf",
      60,
    );
    expect(result).toMatchObject({ status: "text", truncated: true });
    const { text, note } = result as { text: string; note: string };
    expect(text.length).toBeLessThanOrEqual(60);
    expect(text).not.toContain("charlie");
    expect(note).toMatch(/Truncated: the text of \d of 3 pages is shown/);
  });

  it("flags a truncation when the cap is reached exactly at a page boundary", async () => {
    // "--- Page 1 ---\nAAAA" is 19 characters: the cap fills page 1 to the character.
    const result = await extractDocumentTextUncached(pdf(["AAAA", "BBBB", "CCCC"]), "pdf", 19);
    expect(result).toMatchObject({ status: "text", truncated: true });
    expect((result as { note: string }).note).toMatch(/1 of 3 pages/);
    expect((result as { text: string }).text).not.toContain("BBBB");
  });

  it("refuses a decompression bomb instead of inflating it", async () => {
    const bomb = zipSync({ "word/document.xml": new Uint8Array(40 * 1024 * 1024) });
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    expect(await extractDocumentTextUncached(bomb, "docx")).toEqual({
      status: "failed",
      format: "docx",
    });
  });
});

describe("extractDocumentText (cached by sha256)", () => {
  const docx = zip({ "word/document.xml": "<w:p><w:r><w:t>cache</w:t></w:r></w:p>" });

  it("reads the bytes once per content hash", async () => {
    let reads = 0;
    const input = {
      sha256: `hash-${crypto.randomUUID()}`,
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      name: "a.docx",
      size: docx.byteLength,
      read: async () => {
        reads += 1;
        return docx;
      },
    };
    expect(await extractDocumentText(input)).toMatchObject({ status: "text" });
    expect(await extractDocumentText(input)).toMatchObject({ status: "text" });
    expect(reads).toBe(1);
  });

  it("does not cache a read that found no bytes: the next read gets the text", async () => {
    const input = {
      sha256: `hash-${crypto.randomUUID()}`,
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      name: "a.docx",
      size: docx.byteLength,
    };
    expect(await extractDocumentText({ ...input, read: async () => null })).toEqual({
      status: "failed",
      format: "docx",
    });
    expect(await extractDocumentText({ ...input, read: async () => docx })).toMatchObject({
      status: "text",
    });
  });

  it("does not open a file over the source cap, nor a format it does not read", async () => {
    const read = async () => {
      throw new Error("must not be read");
    };
    expect(
      await extractDocumentText({
        sha256: "x",
        mime: "application/pdf",
        size: DOCUMENT_SOURCE_MAX_BYTES + 1,
        read,
      }),
    ).toEqual({ status: "unsupported", reason: "too_large" });
    expect(
      await extractDocumentText({ sha256: "y", mime: "application/zip", size: 10, read }),
    ).toEqual({ status: "unsupported", reason: "format" });
  });
});

describe("hostile markup", () => {
  /** Every extraction of a hostile file must come back fast: the scan runs on the API's event loop. */
  const TIME_LIMIT_MS = 1500;
  const timed = async (
    bytes: Uint8Array,
    format: "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp",
  ) => {
    const started = performance.now();
    const result = await extractDocumentTextUncached(bytes, format);
    expect(performance.now() - started).toBeLessThan(TIME_LIMIT_MS);
    return result;
  };

  const workbook = (sheet: string, sharedStrings = "<sst></sst>") =>
    zip({
      "xl/workbook.xml": `<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/sharedStrings.xml": sharedStrings,
      "xl/worksheets/sheet1.xml": sheet,
    });

  it("reads 80 000 unclosed <si> in linear time (a quadratic scan took 10 s)", async () => {
    await timed(workbook("<worksheet/>", `<sst>${"<si>".repeat(80_000)}</sst>`), "xlsx");
  });

  it("reads 80 000 unclosed <c> and <row> in linear time", async () => {
    await timed(workbook(`<worksheet><sheetData><row>${'<c r="A1">'.repeat(80_000)}`), "xlsx");
    await timed(workbook(`<worksheet><sheetData>${"<row>".repeat(80_000)}`), "xlsx");
  });

  it("reads 80 000 never-terminated tags of a docx, pptx and OpenDocument file in linear time", async () => {
    await timed(zip({ "word/document.xml": "<w:t".repeat(80_000) }), "docx");
    await timed(zip({ "ppt/slides/slide1.xml": "<a:t".repeat(80_000) }), "pptx");
    await timed(zip({ "content.xml": `<office:text>${"<text:p".repeat(80_000)}` }), "odt");
    await timed(
      zip({ "content.xml": `<table:table table:name="T">${"<table:table-cell>".repeat(80_000)}` }),
      "ods",
    );
    await timed(zip({ "content.xml": "<draw:page>".repeat(80_000) }), "odp");
  });

  it("still reads the well-formed part that precedes a never-closed element", async () => {
    const result = await timed(
      zip({ "word/document.xml": "<w:p><w:r><w:t>kept</w:t></w:r></w:p><w:p><w:r><w:t" }),
      "docx",
    );
    expect(result).toMatchObject({ status: "text", text: "kept" });
  });

  it("refuses a content member over the XML cap instead of walking it", async () => {
    const huge = `<worksheet><sheetData>${'<row><c r="A1"><v>1</v></c></row>'.repeat(520_000)}</sheetData></worksheet>`;
    expect(huge.length).toBeGreaterThan(16 * 1024 * 1024);
    expect(await extractDocumentTextUncached(workbook(huge), "xlsx")).toEqual({
      status: "failed",
      format: "xlsx",
    });
  });
});

describe("PDF limits", () => {
  it("returns the pages read so far, flagged as truncated, once the time budget is spent", async () => {
    // A zero budget: page 1 is read, the check before page 2 stops the loop.
    const result = await extractDocumentTextUncached(
      pdf(["premiere", "deuxieme", "troisieme"]),
      "pdf",
      undefined,
      0,
    );
    expect(result).toMatchObject({ status: "text", truncated: true });
    const { text, note } = result as { text: string; note: string };
    expect(text).toContain("premiere");
    expect(text).not.toContain("deuxieme");
    expect(note).toMatch(/1 of 3 pages/);
  });
});

describe("createGate", () => {
  const options = { limit: 2, maxWaiting: 4, waitMs: 1_000, holdMs: 1_000 };

  it("never runs more than the limit at once, and runs everything", async () => {
    const run = createGate(options);
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          done.push(i);
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(done.sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("frees its slot when the work throws", async () => {
    const run = createGate({ ...options, limit: 1 });
    await expect(
      run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await run(async () => "next")).toBe("next");
  });

  it("abandons work that hangs: its signal aborts, its slot goes to the next caller", async () => {
    const run = createGate({ ...options, limit: 1, holdMs: 30 });
    let signal: AbortSignal | undefined;
    const hung = run((s) => {
      signal = s;
      return new Promise<never>(() => {});
    });
    await expect(hung).rejects.toMatchObject({ reason: "hold_timeout" });
    expect(signal?.aborted).toBe(true);
    expect(await run(async () => "next")).toBe("next");
  });

  it("refuses a caller that waits too long, and one that finds the queue full", async () => {
    const run = createGate({ limit: 1, maxWaiting: 1, waitMs: 30, holdMs: 1_000 });
    const hold = run(() => new Promise<void>((resolve) => setTimeout(resolve, 200)));
    const waiter = run(async () => "late");
    await expect(run(async () => "overflow")).rejects.toMatchObject({ reason: "queue_full" });
    await expect(waiter).rejects.toMatchObject({ reason: "wait_timeout" });
    await hold;
    expect(await run(async () => "after")).toBe("after");
  });
});
