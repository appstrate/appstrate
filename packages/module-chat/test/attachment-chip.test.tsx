// SPDX-License-Identifier: Apache-2.0

/**
 * Every chat attachment chip — staged upload or sent file — is one anatomy: a
 * leading media square (an image's thumbnail, else the file type's icon), the
 * name, then what trails it. The remove button never sits inside the preview button.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentChip, PendingAttachmentChip } from "../src/ui/file-attachment.tsx";

const preview = { label: "Aperçu de a", onActivate: () => {} };

describe("PendingAttachmentChip", () => {
  it("shows a staged image as a thumbnail in the media square", () => {
    const file = new File(["x"], "a.png", { type: "image/png" });
    const html = renderToStaticMarkup(
      <PendingAttachmentChip name="a.png" file={file} preview={null} trailing={null} />,
    );
    expect(html).toContain("<img");
    expect(html).not.toContain("<svg");
  });

  it("shows any other staged file as its type's icon", () => {
    const file = new File(["x"], "a.pdf", { type: "application/pdf" });
    const html = renderToStaticMarkup(
      <PendingAttachmentChip name="a.pdf" file={file} preview={null} trailing={null} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("lucide-file-text");
  });

  it("keeps the trailing remove button outside the preview button", () => {
    const file = new File(["x"], "a.pdf", { type: "application/pdf" });
    const html = renderToStaticMarkup(
      <PendingAttachmentChip
        name="a.pdf"
        file={file}
        preview={preview}
        trailing={<button type="button">remove</button>}
      />,
    );
    expect(html).toMatch(/aria-label="Aperçu de a"[^]*<\/button><button type="button">remove/);
  });
});

describe("AttachmentChip", () => {
  it("is the button itself when it opens a file and carries nothing after the name", () => {
    const html = renderToStaticMarkup(
      <AttachmentChip name="a.csv" mime="text/csv" action={preview} />,
    );
    expect(html.startsWith("<button")).toBe(true);
    expect(html).toContain("lucide-file-spreadsheet");
  });

  it("falls back to the neutral file icon without a mime", () => {
    const html = renderToStaticMarkup(<AttachmentChip name="a" />);
    expect(html.startsWith("<div")).toBe(true);
    expect(html).toContain("lucide-file");
  });
});
