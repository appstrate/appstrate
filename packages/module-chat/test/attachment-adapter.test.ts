// SPDX-License-Identifier: Apache-2.0

/**
 * Composer attachment adapter — the space a file is uploaded into, and the message a failed
 * upload puts on the chip.
 *
 * The space is read when the turn is sent: the conversation's limit or the space shown can change
 * after a file is added, and the server accepts an upload only in a space the turn acts in. A file
 * added while there is none is refused before any upload.
 *
 * The host uploader throws with a machine-readable `code` (RFC 9457 `type`
 * suffix). Two of those codes are actionable by the user and must survive into
 * the composer with their own wording; every other failure collapses to the
 * generic message. Pinned here because the adapter deliberately reads `code`
 * structurally rather than importing the host's error class, so a rename on
 * either side is otherwise invisible.
 */

import { describe, it, expect } from "bun:test";
import { createChatAttachmentAdapter } from "../src/ui/attachment-adapter.ts";
import type { UploadFile } from "../src/ui/runtime-context.ts";

const NOTE = () => new File(["hello"], "note.txt", { type: "text/plain" });

function adapterOver(upload: UploadFile, spaceOf: () => string | null = () => "spc_a") {
  // Identity translator: the assertion is on the KEY the adapter picked.
  return createChatAttachmentAdapter({ upload, t: (key: string) => key, spaceOf });
}

/** `err` thrown by the host uploader, for a file added in a space. */
async function sendRejectedWith(err: unknown) {
  const adapter = adapterOver(() => Promise.reject(err));
  return adapter.send(await adapter.add({ file: NOTE() }));
}

describe("chat attachment adapter — the space of an upload", () => {
  it("uploads into the space the conversation acts in when the turn is sent", async () => {
    const uploads: string[] = [];
    let space: string | null = "spc_a";
    const adapter = adapterOver(
      (_file, spaceId) => {
        uploads.push(spaceId);
        return Promise.resolve(`upload://upl_${uploads.length}`);
      },
      () => space,
    );
    const pending = await adapter.add({ file: NOTE() });
    // Limited to another space, or another space shown, before sending.
    space = "spc_b";
    const sent = await adapter.send(pending);
    expect(uploads).toEqual(["spc_b"]);
    expect(sent.content).toMatchObject([{ type: "file", data: "upload://upl_1" }]);
  });

  it("refuses a file with no space, when added or when sent, before any upload", async () => {
    const uploads: string[] = [];
    let space: string | null = null;
    const adapter = adapterOver(
      (_file, spaceId) => {
        uploads.push(spaceId);
        return Promise.resolve("upload://upl_1");
      },
      () => space,
    );
    await expect(adapter.add({ file: NOTE() })).rejects.toThrow("composer.attachUnavailable");
    space = "spc_a";
    const pending = await adapter.add({ file: NOTE() });
    space = null;
    await expect(adapter.send(pending)).rejects.toThrow("composer.attachUnavailable");
    expect(uploads).toEqual([]);
  });
});

describe("chat attachment adapter — upload failure messages", () => {
  it("keeps the org storage quota rejection actionable", async () => {
    await expect(
      sendRejectedWith(
        Object.assign(new Error("Organization storage limit exceeded"), {
          code: "storage_limit_exceeded",
        }),
      ),
    ).rejects.toThrow("upload.storageLimit");
  });

  it("keeps the staging-budget rejection actionable", async () => {
    await expect(
      sendRejectedWith(
        Object.assign(new Error("Too many unconsumed uploads"), {
          code: "upload_staging_limit_exceeded",
        }),
      ),
    ).rejects.toThrow("upload.stagingLimit");
  });

  it("collapses any other failure to the generic message", async () => {
    await expect(
      sendRejectedWith(
        Object.assign(new Error("Internal Server Error"), { code: "internal_error" }),
      ),
    ).rejects.toThrow("upload.failed");
  });

  it("collapses a codeless failure to the generic message", async () => {
    await expect(sendRejectedWith(new TypeError("Failed to fetch"))).rejects.toThrow(
      "upload.failed",
    );
  });
});
