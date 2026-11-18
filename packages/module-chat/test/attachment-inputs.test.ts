// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import { loadAttachmentImages, readPromptPdfs } from "../src/pi-chat/attachment-inputs.ts";
import { createTurnPdfInput } from "../src/pi-chat/native-pdf.ts";
import { RESOURCE_BLOB_MAX_BYTES } from "@appstrate/mcp-transport";
import { INLINE_IMAGE_BUDGET_BYTES } from "@appstrate/runner-pi";

function user(id: string, ...uris: string[]): UIMessage {
  return {
    id,
    role: "user",
    parts: [
      { type: "text", text: "regarde" },
      ...uris.map((url) => ({
        type: "file" as const,
        url,
        mediaType: url.endsWith(".pdf") ? "application/pdf" : "image/png",
      })),
    ],
  };
}

const signal = new AbortController().signal;
const pixel = { mime: "image/png", bytes: new Uint8Array([1, 2, 3]) };

describe("loadAttachmentImages", () => {
  it("reads recent supported images once and keeps the original bytes", async () => {
    const reads: string[] = [];
    const messages = Array.from({ length: 5 }, (_, i) =>
      user(String(i), `appfile://file_${i}`, `appfile://file_${i}`, "appfile://file_doc.pdf"),
    );
    const result = await loadAttachmentImages(
      messages,
      async (uri, limit) => {
        reads.push(uri);
        expect(limit).toBe(RESOURCE_BLOB_MAX_BYTES);
        return pixel;
      },
      signal,
    );
    expect(reads).toEqual(["appfile://file_4", "appfile://file_3", "appfile://file_2"]);
    expect(result.get("4")?.get(reads[0]!)).toEqual({
      type: "image",
      data: "AQID",
      mimeType: "image/png",
    });
  });

  it("bounds reads per message and shares a byte budget across replay and the current request", async () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      user(String(i), ...Array.from({ length: 6 }, (_, j) => `appfile://file_${i}_${j}`)),
    );
    const result = await loadAttachmentImages(
      messages,
      async (_uri, maxBytes) => ({ ...pixel, bytes: new Uint8Array(maxBytes) }),
      signal,
    );
    expect(result.get("4")?.size).toBe(4);
    const total = [...result.values()].reduce(
      (sum, images) => sum + [...images.values()].reduce((n, image) => n + image.data.length, 0),
      0,
    );
    expect(total).toBe(INLINE_IMAGE_BUDGET_BYTES);
  });

  it("keeps working after an inaccessible or missing file", async () => {
    const result = await loadAttachmentImages(
      [user("1", "gone", "denied", "ok")],
      async (uri) => {
        if (uri === "gone") throw new Error("storage unavailable");
        return uri === "denied" ? null : pixel;
      },
      signal,
    );
    expect([...result.get("1")!.keys()]).toEqual(["ok"]);
  });
});

describe("readPromptPdfs", () => {
  it("reads at most four distinct PDFs and keeps a receipt for the fifth", async () => {
    const uris = ["0.pdf", "0.pdf", "1.pdf", "2.pdf", "3.pdf", "4.pdf"];
    const read: string[] = [];
    const receipts = await readPromptPdfs(
      user("current", ...uris),
      createTurnPdfInput("openai-responses"),
      async (uri) => {
        read.push(uri);
        return { mime: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.7") };
      },
      signal,
    );
    expect(read).toEqual(["0.pdf", "1.pdf", "2.pdf", "3.pdf"]);
    expect(receipts.get("4.pdf")).toContain("at most four PDFs");
  });
});
