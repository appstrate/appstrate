// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import {
  ATTACHMENT_IMAGE_BUDGET_BYTES,
  REQUEST_BINARY_BUDGET_BYTES,
  loadAttachmentImages,
  readPromptPdfs,
} from "../src/pi-chat/attachment-inputs.ts";
import { createTurnPdfInput } from "../src/pi-chat/native-pdf.ts";
import { RESOURCE_BLOB_MAX_BYTES } from "@appstrate/mcp-transport";
import { INLINE_IMAGE_BUDGET_BYTES } from "@appstrate/runner-pi";
import { RESOURCE_BLOB_MAX_BYTES } from "@appstrate/mcp-transport";

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

  it("expires an image after three subsequent user messages even if all are text only", async () => {
    const image = user("image", "appfile://file_chart");
    const reply: UIMessage = {
      id: "reply",
      role: "assistant",
      parts: [{ type: "text", text: "OK" }],
    };
    const messages = [image, reply, user("text1"), user("text2")];
    const reads: string[] = [];
    const read = async (uri: string) => {
      reads.push(uri);
      return pixel;
    };
    expect((await loadAttachmentImages(messages, read, signal)).has(image.id)).toBe(true);
    expect((await loadAttachmentImages([...messages, user("text3")], read, signal)).size).toBe(0);
    expect(reads).toEqual(["appfile://file_chart"]);
  });

  it("bounds reads per message and shares a byte budget across replay and the current request", async () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      user(String(i), ...Array.from({ length: 6 }, (_, j) => `appfile://file_${i}_${j}`)),
    );
    const small = await loadAttachmentImages(
      messages,
      async () => ({ ...pixel, bytes: new Uint8Array(1024) }),
      signal,
    );
    expect(small.get("4")?.size).toBe(4);
    const result = await loadAttachmentImages(
      messages,
      async (_uri, maxBytes) => ({ ...pixel, bytes: new Uint8Array(maxBytes) }),
      signal,
    );
    const total = [...result.values()].reduce(
      (sum, images) => sum + [...images.values()].reduce((n, image) => n + image.data.length, 0),
      0,
    );
    // The attachments' share, up to the base64 rounding of the last image.
    expect(total).toBeLessThanOrEqual(ATTACHMENT_IMAGE_BUDGET_BYTES);
    expect(total).toBeGreaterThan(ATTACHMENT_IMAGE_BUDGET_BYTES - 8);
  });

  it("keeps every binary of one request, together, under the llm-proxy's 10 MiB request cap", () => {
    const pdfs = Math.ceil(RESOURCE_BLOB_MAX_BYTES / 3) * 4;
    expect(ATTACHMENT_IMAGE_BUDGET_BYTES + INLINE_IMAGE_BUDGET_BYTES + pdfs).toBe(
      REQUEST_BINARY_BUDGET_BYTES,
    );
    // Room for the text of the conversation, which the request carries too.
    expect(10 * 1024 * 1024 - REQUEST_BINARY_BUDGET_BYTES).toBeGreaterThanOrEqual(3 * 1024 * 1024);
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
      createTurnPdfInput({ api: "openai-responses" }),
      async (uri) => {
        read.push(uri);
        return { mime: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.7") };
      },
      signal,
    );
    expect(read).toEqual(["0.pdf", "1.pdf", "2.pdf", "3.pdf"]);
    expect(receipts.get("4.pdf")).toContain("at most 4 per message");
  });

  it("reads no PDF when the turn sends none, and tells the model why", async () => {
    const turn = createTurnPdfInput({ api: "openai-responses", input: ["text"] });
    const receipts = await readPromptPdfs(
      user("current", "0.pdf"),
      turn,
      async () => {
        throw new Error("must not read");
      },
      signal,
    );
    expect(receipts.get("0.pdf")).toBe(turn.unsupported!);
  });
});
