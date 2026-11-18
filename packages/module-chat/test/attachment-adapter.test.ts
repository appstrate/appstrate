// SPDX-License-Identifier: Apache-2.0

/**
 * Composer attachment adapter — the space a file is uploaded into, and the message a failed
 * upload puts on the chip.
 *
 * The space is the one the file was added in (the user's choice then), checked when the turn is
 * sent against the spaces that turn reads: the server resolves an upload only among them, so a
 * file whose space the turn no longer reads fails, naming the space, before any upload. A file
 * added while there is no space is refused before any upload.
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
import { turnSpacesOf } from "../src/ui/conversation-scope.ts";
import type { UploadFile } from "../src/ui/runtime-context.ts";

const NOTE = () => new File(["hello"], "note.txt", { type: "text/plain" });
const NAMES: Record<string, string> = { spc_a: "Studio", spc_b: "Atelier" };

function adapterOver(
  upload: UploadFile,
  spaceOf: () => string | null = () => "spc_a",
  turnSpaces: () => readonly string[] | null = () => ["spc_a", "spc_b"],
) {
  // The translator echoes the KEY the adapter picked, and the space it names.
  return createChatAttachmentAdapter({
    upload,
    t: (key, params) => (params?.space ? `${key}|${String(params.space)}` : key),
    spaceOf,
    turnSpaces,
    spaceLabelOf: (spaceId) => NAMES[spaceId],
  });
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
  it("uploads a single file into the space it was added in", async () => {
    const { upload, uploads } = recordingUpload();
    const adapter = adapterOver(upload);
    const sent = await adapter.send(await adapter.add({ file: NOTE() }));
    expect(uploads).toEqual(["spc_a"]);
    expect(sent.content).toMatchObject([{ type: "file", data: "upload://upl_1" }]);
  });

  it("uploads two files picked in two spaces each into its own", async () => {
    const { upload, uploads } = recordingUpload();
    let space = "spc_a";
    const adapter = adapterOver(upload, () => space);
    const first = await adapter.add({ file: NOTE() });
    space = "spc_b";
    const second = await adapter.add({ file: NOTE() });
    await adapter.send(first);
    await adapter.send(second);
    expect(uploads).toEqual(["spc_a", "spc_b"]);
  });

  it("fails a file whose space the turn no longer reads, naming it, and uploads nothing", async () => {
    const { upload, uploads } = recordingUpload();
    let readable: readonly string[] = ["spc_a", "spc_b"];
    const adapter = adapterOver(
      upload,
      () => "spc_b",
      () => readable,
    );
    const pending = await adapter.add({ file: NOTE() });
    // Limited to another space after attaching.
    readable = turnSpacesOf({ originSpaceId: "spc_a", restricted: true }, ["spc_a", "spc_b"])!;
    await expect(adapter.send(pending)).rejects.toThrow("upload.spaceNotRead|Atelier");
    // A space the host cannot name gets the generic sentence.
    const unseen = adapterOver(
      upload,
      () => "spc_unseen",
      () => readable,
    );
    await expect(unseen.send(await unseen.add({ file: NOTE() }))).rejects.toThrow(
      "upload.spaceNotReadUnnamed",
    );
    expect(uploads).toEqual([]);
  });

  it("refuses a file with no space, or sent while the turn's spaces are unknown", async () => {
    const { upload, uploads } = recordingUpload();
    let space: string | null = null;
    let readable: readonly string[] | null = ["spc_a"];
    const adapter = adapterOver(
      upload,
      () => space,
      () => readable,
    );
    await expect(adapter.add({ file: NOTE() })).rejects.toThrow("composer.attachUnavailable");
    space = "spc_a";
    const pending = await adapter.add({ file: NOTE() });
    readable = null;
    await expect(adapter.send(pending)).rejects.toThrow("composer.attachUnavailable");
    expect(uploads).toEqual([]);
  });
});

describe("the spaces a turn reads", () => {
  const acting = ["spc_a", "spc_b"];
  it("is the origin alone while limited, else the acting set, unknown while it is", () => {
    expect(turnSpacesOf({ originSpaceId: "spc_a", restricted: true }, acting)).toEqual(["spc_a"]);
    expect(turnSpacesOf({ originSpaceId: "spc_x", restricted: true }, acting)).toEqual([]);
    expect(turnSpacesOf({ originSpaceId: "spc_a", restricted: false }, acting)).toEqual(acting);
    expect(turnSpacesOf({ originSpaceId: null, restricted: false }, acting)).toEqual(acting);
    expect(turnSpacesOf({ originSpaceId: "spc_a", restricted: true }, null)).toBeNull();
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
