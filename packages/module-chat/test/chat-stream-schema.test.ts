// SPDX-License-Identifier: Apache-2.0

/**
 * `chatStreamSchema` file-part validation (superRefine) — a pure, DB-free
 * validation-level check that the chat channel only accepts attachments
 * addressed by an `upload://` or `document://` URI, rejecting inline `data:`
 * bytes and arbitrary URLs (attachments must flow through the document store).
 */

import { describe, it, expect } from "bun:test";
import { chatStreamSchema } from "../src/chat-stream.ts";

function messageWithFileUrl(url: string) {
  return {
    messages: [
      {
        role: "user",
        parts: [{ type: "file", url, mediaType: "application/pdf", filename: "x.pdf" }],
      },
    ],
  };
}

describe("chatStreamSchema file-part validation", () => {
  it("accepts an upload:// file part", () => {
    const result = chatStreamSchema.safeParse(messageWithFileUrl("upload://upl_abcdefgh"));
    expect(result.success).toBe(true);
  });

  it("accepts a document:// file part", () => {
    const result = chatStreamSchema.safeParse(messageWithFileUrl("document://doc_abcdefgh"));
    expect(result.success).toBe(true);
  });

  it("rejects an inline data: file part", () => {
    const result = chatStreamSchema.safeParse(
      messageWithFileUrl("data:application/pdf;base64,QUJD"),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["messages", 0, "parts", 0, "url"]);
    }
  });

  it("rejects an https:// file part", () => {
    const result = chatStreamSchema.safeParse(messageWithFileUrl("https://example.com/x.pdf"));
    expect(result.success).toBe(false);
  });

  it("rejects a file part with a missing url", () => {
    const result = chatStreamSchema.safeParse({
      messages: [{ role: "user", parts: [{ type: "file", mediaType: "application/pdf" }] }],
    });
    expect(result.success).toBe(false);
  });

  it("leaves non-file parts untouched", () => {
    const result = chatStreamSchema.safeParse({
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
    });
    expect(result.success).toBe(true);
  });
});
