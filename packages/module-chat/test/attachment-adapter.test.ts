// SPDX-License-Identifier: Apache-2.0

/**
 * Composer attachment adapter — the space a file is uploaded into, and the message a failed
 * upload puts on the chip.
 *
 * Every file goes to the caller's personal space, whatever the conversation reads or the view
 * shows; a file added or sent while that space is not known is refused before any upload.
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
import type { AttachTarget, AttachUnavailable, UploadFile } from "../src/ui/runtime-context.ts";

const NOTE = () => new File(["hello"], "note.txt", { type: "text/plain" });

function adapterOver(
  upload: UploadFile,
  attachTarget: () => AttachTarget = () => ({ spaceId: "spc_me" }),
) {
  // The translator echoes the KEY the adapter picked.
  return createChatAttachmentAdapter({ upload, t: (key) => key, attachTarget });
}

/** An uploader recording the space of each upload. */
function recordingUpload(): { upload: UploadFile; uploads: string[] } {
  const uploads: string[] = [];
  return {
    uploads,
    upload: (_file, spaceId) => {
      uploads.push(spaceId);
      return Promise.resolve(`upload://upl_${uploads.length}`);
    },
  };
}

/** `err` thrown by the host uploader, for a file added in a space. */
async function sendRejectedWith(err: unknown) {
  const adapter = adapterOver(() => Promise.reject(err));
  return adapter.send(await adapter.add({ file: NOTE() }));
}

describe("chat attachment adapter — the space of an upload", () => {
  it("stages a file into the personal space", async () => {
    const { upload, uploads } = recordingUpload();
    const adapter = adapterOver(upload);
    const sent = await adapter.send(await adapter.add({ file: NOTE() }));
    expect(uploads).toEqual(["spc_me"]);
    expect(sent.content).toMatchObject([{ type: "file", data: "upload://upl_1" }]);
  });

  it("stages every file there, whatever the conversation reads or the view shows", async () => {
    // A multi-space view (« Tous les espaces ») or a conversation limited to another space is
    // not a reason to ask or to refuse: the adapter knows no other space.
    const { upload, uploads } = recordingUpload();
    const adapter = adapterOver(upload);
    await adapter.send(await adapter.add({ file: NOTE() }));
    await adapter.send(await adapter.add({ file: NOTE() }));
    expect(uploads).toEqual(["spc_me", "spc_me"]);
  });

  it("refuses a file while the personal space is not known, and uploads nothing", async () => {
    const { upload, uploads } = recordingUpload();
    let target: AttachTarget = { unavailable: "loading" };
    const adapter = adapterOver(upload, () => target);
    await expect(adapter.add({ file: NOTE() })).rejects.toThrow("composer.attachUnavailable");
    target = { spaceId: "spc_me" };
    const pending = await adapter.add({ file: NOTE() });
    target = { unavailable: "loading" };
    await expect(adapter.send(pending)).rejects.toThrow("composer.attachUnavailable");
    expect(uploads).toEqual([]);
  });
});

describe("chat attachment adapter — no personal space", () => {
  it("tells why, per reason: loading, a failed listing, a role preview", async () => {
    const reasons = {
      loading: "composer.attachUnavailable",
      error: "composer.attachError",
      preview: "composer.attachPreview",
    } as const;
    for (const [reason, message] of Object.entries(reasons)) {
      const adapter = adapterOver(recordingUpload().upload, () => ({
        unavailable: reason as AttachUnavailable,
      }));
      await expect(adapter.add({ file: NOTE() })).rejects.toThrow(message);
    }
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
