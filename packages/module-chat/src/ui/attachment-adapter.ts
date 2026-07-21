// SPDX-License-Identifier: Apache-2.0

/**
 * assistant-ui `AttachmentAdapter` for the chat composer (pinned
 * `@assistant-ui/react` 0.14.27). Its three methods:
 *
 *  - `add({file})` — register a picked file as a pending attachment (a chip);
 *    the client-side size guard rejects an over-cap file here, before any upload.
 *  - `send(pending)` — on composer submit, stage the bytes through the 2-step
 *    upload API and return a complete attachment whose `file` content part
 *    carries the `upload://upl_x` URI. react-ai-sdk's `toCreateMessage` maps that
 *    part to an ai-SDK file part (`url: upload://…`) on the outgoing UIMessage;
 *    the server then materializes it into a durable `document://` document.
 *  - `remove()` — no server round-trip (staging only happens in `send`; an
 *    abandoned upload record is swept by the upload GC).
 */

import type { AttachmentAdapter, CompleteAttachment, PendingAttachment } from "@assistant-ui/react";
import type { GetHeaders } from "./runtime-context.ts";
import {
  ATTACHMENT_TOO_LARGE_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  uploadComposerFile,
} from "./upload.ts";

export function createChatAttachmentAdapter(
  getHeaders: GetHeaders | null | undefined,
): AttachmentAdapter {
  return {
    // Any file type — the composer accepts arbitrary documents (the agent's
    // input schema, not the composer, decides what a run will accept).
    accept: "*",
    add({ file }): Promise<PendingAttachment> {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        return Promise.reject(new Error(ATTACHMENT_TOO_LARGE_MESSAGE));
      }
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
      const uri = await uploadComposerFile(attachment.file, getHeaders);
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
