// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MimeIcon } from "../src/components/mime-icon.tsx";

/** The Lucide icon class a mime (and name) renders (`lucide-file-text`, `lucide-presentation`…). */
const iconOf = (mime: string, name?: string) =>
  /lucide-(file[a-z-]*|presentation)/.exec(
    renderToStaticMarkup(<MimeIcon mime={mime} name={name} />),
  )?.[1];

describe("MimeIcon", () => {
  it("maps common families", () => {
    expect(iconOf("image/png")).toBe("file-image");
    expect(iconOf("text/html")).toBe("file-code");
    expect(iconOf("application/json")).toBe("file-code");
    expect(iconOf("application/zip")).toBe("file-archive");
    expect(iconOf("text/csv")).toBe("file-spreadsheet");
    expect(iconOf("text/plain")).toBe("file-text");
    expect(iconOf("application/pdf")).toBe("file-text");
  });

  it("falls back to the neutral file icon", () => {
    expect(iconOf("application/octet-stream")).toBe("file");
    expect(iconOf("")).toBe("file");
  });

  it("tells a presentation from a document by MIME", () => {
    expect(
      iconOf("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    ).toBe("presentation");
    expect(iconOf("application/vnd.ms-powerpoint")).toBe("presentation");
    expect(iconOf("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(
      "file-text",
    );
  });

  it("reads the extension when the MIME is empty or generic, and only then", () => {
    expect(iconOf("application/octet-stream", "ventes.XLSX")).toBe("file-spreadsheet");
    expect(iconOf("", "deck.pptx")).toBe("presentation");
    expect(iconOf("", "contrat.docx")).toBe("file-text");
    expect(iconOf("image/png", "faux.pdf")).toBe("file-image");
    expect(iconOf("application/octet-stream", "inconnu.xyz")).toBe("file");
  });

  it("is not fooled by an extension that names a property of Object.prototype", () => {
    for (const name of ["a.constructor", "a.__proto__", "a.toString"]) {
      expect(iconOf("", name)).toBe("file");
    }
  });
});
