// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { pdfBytes as pdf } from "../../helpers/pdf.ts";
import {
  documentFormatOf,
  extractDocumentText,
  extractDocumentTextUncached,
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
