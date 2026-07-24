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
 *    server then materializes it into a durable `document://` document.
 *  - `remove()` — no server round-trip (staging only happens in `send`; an
 *    abandoned upload record is swept by the upload GC).
 *
 * The uploader, the size cap and the translator all come from the host
 * injection seam (`runtime-context.ts`) — the adapter owns no transport and no
 * literal text.
 */

import type { AttachmentAdapter, CompleteAttachment, PendingAttachment } from "@assistant-ui/react";
import type { ChatTranslate, UploadFile } from "./runtime-context.ts";
import { stageComposerFile } from "./upload.ts";

export function createChatAttachmentAdapter(deps: {
  upload: UploadFile;
  /** Per-upload byte cap the platform enforces (UX fast-path; server still 413s). */
  maxBytes: number;
  t: ChatTranslate;
}): AttachmentAdapter {
  const { upload, maxBytes, t } = deps;
  const tooLarge = () =>
    new Error(t("upload.tooLarge", { max: Math.round(maxBytes / 1024 / 1024) }));
  return {
    // Any file type — the composer accepts arbitrary documents (the agent's
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
      } catch {
        // The host uploader's message is technical (status codes, English) and
        // ends up in the composer chip — surface the translated one instead.
        throw new Error(t("upload.failed"));
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
