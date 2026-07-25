// SPDX-License-Identifier: Apache-2.0

/**
 * Composer attachment adapter — the message a failed upload puts on the chip.
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

function adapterRejectingWith(err: unknown) {
  return createChatAttachmentAdapter({
    upload: () => Promise.reject(err),
    // Identity translator: the assertion is on the KEY the adapter picked.
    t: (key: string) => key,
  });
}

function pendingFile() {
  return {
    id: "att_1",
    type: "file" as const,
    name: "note.txt",
    contentType: "text/plain",
    file: new File(["hello"], "note.txt", { type: "text/plain" }),
    status: { type: "requires-action" as const, reason: "composer-send" as const },
  };
}

describe("chat attachment adapter — upload failure messages", () => {
  it("keeps the org storage quota rejection actionable", async () => {
    const adapter = adapterRejectingWith(
      Object.assign(new Error("Organization storage limit exceeded"), {
        code: "storage_limit_exceeded",
      }),
    );
    await expect(adapter.send(pendingFile())).rejects.toThrow("upload.storageLimit");
  });

  it("keeps the staging-budget rejection actionable", async () => {
    const adapter = adapterRejectingWith(
      Object.assign(new Error("Too many unconsumed uploads"), {
        code: "upload_staging_limit_exceeded",
      }),
    );
    await expect(adapter.send(pendingFile())).rejects.toThrow("upload.stagingLimit");
  });

  it("collapses any other failure to the generic message", async () => {
    const adapter = adapterRejectingWith(
      Object.assign(new Error("Internal Server Error"), { code: "internal_error" }),
    );
    await expect(adapter.send(pendingFile())).rejects.toThrow("upload.failed");
  });

  it("collapses a codeless failure to the generic message", async () => {
    const adapter = adapterRejectingWith(new TypeError("Failed to fetch"));
    await expect(adapter.send(pendingFile())).rejects.toThrow("upload.failed");
  });
});
