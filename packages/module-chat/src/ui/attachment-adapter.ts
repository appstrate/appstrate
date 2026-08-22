// SPDX-License-Identifier: Apache-2.0

/**
 * assistant-ui `AttachmentAdapter` for the chat composer (pinned
 * `@assistant-ui/react` 0.14.27). Its three methods:
 *
 *  - `add({file})` — register a picked file as a pending attachment (a chip);
 *    the client-side size guard rejects an over-cap file here, before any upload.
 *  - `send(pending)` — on composer submit, stage the bytes through the host's
 *    uploader and return a complete attachment whose `file` content part carries
 *    the `upload://upl_x` URI. react-ai-sdk's `toCreateMessage` maps that part to
 *    an ai-SDK file part (`url: upload://…`) on the outgoing UIMessage; the
 *    server then materializes it into a durable `appfile://` file.
 *  - `remove()` — no server round-trip (staging only happens in `send`; an
 *    abandoned upload record is swept by the upload GC).
 *
 * The uploader and the translator come from the host injection seam
 * (`runtime-context.ts`) — the adapter owns no transport and no literal text.
 * The size cap does NOT: `UPLOAD_MAX_BYTES` is a shared CONSTANT of the upload
 * contract (deliberately not an env knob — see `@appstrate/core/storage`), the
 * same value the create-upload route and the signed sink token encode. Reading
 * it straight from core is one import; threading it through a prop, a provider
 * and a context would only add ways for the browser to guard a stale number.
 */

import type { AttachmentAdapter, CompleteAttachment, PendingAttachment } from "@assistant-ui/react";
import { UPLOAD_MAX_BYTES } from "@appstrate/core/storage";
import type { ChatTranslate, UploadFile } from "./runtime-context.ts";
import { stageComposerFile } from "./upload.ts";

/**
 * Map an upload rejection to its composer message key. The org storage quota
 * and the staging budget are the only two the user can act on (free space, or
 * wait for staged uploads to be consumed); everything else stays generic.
 */
function uploadFailureKey(err: unknown): string {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
  if (code === "storage_limit_exceeded") return "upload.storageLimit";
  if (code === "upload_staging_limit_exceeded") return "upload.stagingLimit";
  return "upload.failed";
}

export function createChatAttachmentAdapter(deps: {
  upload: UploadFile;
  t: ChatTranslate;
}): AttachmentAdapter {
  const { upload, t } = deps;
  const maxBytes = UPLOAD_MAX_BYTES;
  const tooLarge = () =>
    new Error(t("upload.tooLarge", { max: Math.round(maxBytes / 1024 / 1024) }));
  return {
    // Any file type — the composer accepts arbitrary files (the agent's
    // input schema, not the composer, decides what a run will accept).
    accept: "*",
    add({ file }): Promise<PendingAttachment> {
      if (file.size > maxBytes) return Promise.reject(tooLarge());
      return Promise.resolve({
        id: crypto.randomUUID(),
        type: "file",
        name: file.name,
        contentType: file.type || "application/octet-stream",
        file,
        status: { type: "requires-action", reason: "composer-send" },
      });
    },
    async send(attachment): Promise<CompleteAttachment> {
      if (attachment.file.size > maxBytes) throw tooLarge();
      let uri: string;
      try {
        uri = await stageComposerFile(upload, attachment.file);
      } catch (err) {
        // The host uploader's message is technical (status codes, English) and
        // ends up in the composer chip — surface the translated one instead.
        // Two rejections ARE actionable by the user, so they keep their own
        // wording; `code` is read structurally to avoid depending on the host's
        // error class.
        throw new Error(t(uploadFailureKey(err)));
      }
      return {
        ...attachment,
        status: { type: "complete" },
        content: [
          {
            type: "file",
            data: uri,
            mimeType: attachment.contentType ?? "application/octet-stream",
            filename: attachment.name,
          },
        ],
      };
    },
    remove(): Promise<void> {
      return Promise.resolve();
    },
  };
}
