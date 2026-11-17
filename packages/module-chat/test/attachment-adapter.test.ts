// SPDX-License-Identifier: Apache-2.0

/**
 * Composer attachment adapter — the space a file is uploaded into, and the message a failed
 * upload puts on the chip.
 *
 * The space is read when the file is added (`attachSpaceOf`): the upload names it, whatever is
 * decided afterwards, and a file added with none is refused before any upload.
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
  it("uploads each file into the space read when it was added", async () => {
    const uploads: string[] = [];
    let space: string | null = "spc_a";
    const adapter = adapterOver(
      (_file, spaceId) => {
        uploads.push(spaceId);
        return Promise.resolve(`upload://upl_${uploads.length}`);
      },
      () => space,
    );
    const first = await adapter.add({ file: NOTE() });
    space = "spc_b";
    const second = await adapter.add({ file: NOTE() });
    space = "spc_c";
    const sent = await adapter.send(first);
    await adapter.send(second);
    expect(uploads).toEqual(["spc_a", "spc_b"]);
    expect(sent.content).toMatchObject([{ type: "file", data: "upload://upl_1" }]);
  });

  it("keeps the pending file's destination when the adapter is recreated", async () => {
    const pending = await adapterOver(() => Promise.reject()).add({ file: NOTE() });
    const changed = adapterOver(
      (_file, spaceId) => Promise.resolve(`upload://${spaceId}`),
      () => "spc_b",
    );
    expect((await changed.send(pending)).content).toMatchObject([{ data: "upload://spc_a" }]);
  });

  it("refuses a file added with no space, before any upload", async () => {
    const uploads: string[] = [];
    const adapter = adapterOver(
      (_file, spaceId) => {
        uploads.push(spaceId);
        return Promise.resolve("upload://upl_1");
      },
      () => null,
    );
    await expect(adapter.add({ file: NOTE() })).rejects.toThrow("composer.attachUnavailable");
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
