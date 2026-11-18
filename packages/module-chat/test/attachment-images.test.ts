// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import {
  ATTACHMENT_IMAGES_PER_MESSAGE,
  ATTACHMENT_IMAGES_REQUEST_MAX_BYTES,
  fitToolImages,
  ATTACHMENT_IMAGE_TURNS,
  loadAttachmentImages,
  type AttachmentImageDeps,
} from "../src/pi-chat/attachment-images.ts";

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

/** Reads `data` for every URI, records what was read, resizes to identity. */
function deps(over: Partial<AttachmentImageDeps> & { size?: number } = {}) {
  const reads: string[] = [];
  const impl: AttachmentImageDeps = {
    read:
      over.read ??
      (async (uri) => {
        reads.push(uri);
        return { mime: "image/png", data: "A".repeat(over.size ?? 8), size: 6 };
      }),
    resize:
      over.resize ??
      (async (_bytes, mime) => ({ data: "B".repeat(over.size ?? 8), mimeType: mime })),
  };
  return { impl, reads };
}

describe("loadAttachmentImages", () => {
  it("sends the pixels of an attached image, keyed by message then URI", async () => {
    const { impl } = deps();
    const result = await loadAttachmentImages([user("u1", "appfile://file_a")], impl);
    expect(result.get("u1")?.get("appfile://file_a")).toEqual({
      type: "image",
      data: "BBBBBBBB",
      mimeType: "image/png",
    });
  });

  it("never reads a non-image attachment", async () => {
    const { impl, reads } = deps();
    const result = await loadAttachmentImages([user("u1", "appfile://file_doc.pdf")], impl);
    expect(reads).toEqual([]);
    expect(result.size).toBe(0);
  });

  it("keeps the images of the newest turns only", async () => {
    const { impl } = deps();
    const messages = Array.from({ length: ATTACHMENT_IMAGE_TURNS + 2 }, (_, i) =>
      user(`u${i}`, `appfile://file_${i}`),
    );
    const result = await loadAttachmentImages(messages, impl);
    expect([...result.keys()].sort()).toEqual(
      messages
        .slice(-ATTACHMENT_IMAGE_TURNS)
        .map((m) => m.id)
        .sort(),
    );
  });

  it("caps the images of one message and keeps the first ones", async () => {
    const { impl } = deps();
    const uris = Array.from(
      { length: ATTACHMENT_IMAGES_PER_MESSAGE + 3 },
      (_, i) => `appfile://file_${i}`,
    );
    const result = await loadAttachmentImages([user("u1", ...uris)], impl);
    expect([...result.get("u1")!.keys()]).toEqual(uris.slice(0, ATTACHMENT_IMAGES_PER_MESSAGE));
  });

  it("spends the request budget newest-first and skips what no longer fits", async () => {
    const { impl } = deps({ size: ATTACHMENT_IMAGES_REQUEST_MAX_BYTES / 2 + 1 });
    const result = await loadAttachmentImages(
      [user("old", "appfile://file_old"), user("new", "appfile://file_new")],
      impl,
    );
    // Two images do not fit: the turn being answered wins, the older one keeps its pointer.
    expect(result.has("new")).toBe(true);
    expect(result.has("old")).toBe(false);
  });

  it("skips a file that cannot be read, resized or that throws, without failing", async () => {
    const unreadable = deps({ read: async () => null });
    expect(
      (await loadAttachmentImages([user("u1", "appfile://file_a")], unreadable.impl)).size,
    ).toBe(0);

    const unsizable = deps({ resize: async () => null });
    expect(
      (await loadAttachmentImages([user("u1", "appfile://file_a")], unsizable.impl)).size,
    ).toBe(0);

    const throwing = deps({
      read: async () => {
        throw new Error("storage down");
      },
    });
    expect((await loadAttachmentImages([user("u1", "appfile://file_a")], throwing.impl)).size).toBe(
      0,
    );
  });

  it("reads a URI repeated in one message once", async () => {
    const { impl, reads } = deps();
    await loadAttachmentImages([user("u1", "appfile://file_a", "appfile://file_a")], impl);
    expect(reads).toEqual(["appfile://file_a"]);
  });
});

describe("fitToolImages (an image a tool returned: read_file, read_resource)", () => {
  const image = (data: string) => ({ type: "image" as const, data, mimeType: "image/png" });
  const shrink = (size: number) => async () => ({ data: "S".repeat(size), mimeType: "image/jpeg" });

  it("sends the downscaled image, not the original", async () => {
    const fitted = await fitToolImages(
      [{ type: "text", text: "[image image/png — appfile://file_a]" }, image("QUJD".repeat(1000))],
      shrink(10),
    );
    expect(fitted[0]).toEqual({ type: "text", text: "[image image/png — appfile://file_a]" });
    expect(fitted[1]).toEqual({ type: "image", data: "SSSSSSSSSS", mimeType: "image/jpeg" });
  });

  it("becomes a pointer when the image cannot be downscaled, never the original bytes", async () => {
    const original = "QUJD".repeat(2000);
    const fitted = await fitToolImages([image(original)], async () => null);
    expect(fitted).toEqual([expect.objectContaining({ type: "text" })]);
    expect(JSON.stringify(fitted)).not.toContain(original);
  });

  it("survives a resizer that throws", async () => {
    const fitted = await fitToolImages([image("a")], async () => {
      throw new Error("worker died");
    });
    expect(fitted).toEqual([expect.objectContaining({ type: "text" })]);
  });
});
