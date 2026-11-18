// SPDX-License-Identifier: Apache-2.0

/**
 * Every chat attachment chip — staged upload, sent or produced file — is one anatomy: a
 * leading media square (an image's thumbnail, else the file type's icon), the
 * name, then what trails it. The remove button never sits inside the preview button.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AttachmentChip,
  FileAttachment,
  PendingAttachmentChip,
} from "../src/ui/file-attachment.tsx";
import { ChatHostProvider } from "../src/ui/runtime-context.ts";
import { testHost } from "./test-host.ts";

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

describe("FileAttachment", () => {
  const render = (mime: string, src: string | null | undefined) =>
    renderToStaticMarkup(
      <ChatHostProvider value={testHost({ useFileImageSrc: () => src })}>
        <FileAttachment file={{ id: "f1", name: "a", mime }} />
      </ChatHostProvider>,
    );

  it("shows a stored image as the chip, its thumbnail in the media square", () => {
    // React 19 hoists a `<link rel="preload">` for the image ahead of the markup.
    const html = render("image/png", "blob:thumb");
    expect(html).toMatch(/<button[^>]*aria-label="file\.previewOf"[^]*src="blob:thumb"/);
    expect(html).toContain('src="blob:thumb"');
    expect(html).toContain("size-6");
    expect(html).toContain("file.previewOf");
  });

  it("holds the media square while the thumbnail loads", () => {
    const html = render("image/png", undefined);
    expect(html.startsWith("<button")).toBe(true);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg");
  });

  it("falls back to the image type's icon when the thumbnail cannot load", () => {
    const html = render("image/png", null);
    expect(html).not.toContain("<img");
    expect(html).toContain("lucide-file-image");
  });

  it("never reads a thumbnail for a non-image", () => {
    const html = render("application/pdf", "blob:thumb");
    expect(html).not.toContain("<img");
    expect(html).toContain("lucide-file-text");
  });
});
