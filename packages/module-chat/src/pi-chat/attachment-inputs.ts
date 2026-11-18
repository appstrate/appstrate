// SPDX-License-Identifier: Apache-2.0

import type { UIMessage } from "ai";
import { PDF_INPUT_UNSUPPORTED, type TurnPdfInput } from "./native-pdf.ts";
import type { ChatAttachmentRead, ChatAttachmentContent } from "@appstrate/core/chat-contract";
import { isRasterImageMime } from "@appstrate/core/mime";
import { RESOURCE_BLOB_MAX_BYTES } from "@appstrate/mcp-transport";
import { INLINE_IMAGE_BUDGET_BYTES, type Message } from "@appstrate/runner-pi";
import { logger } from "../logger.ts";

type UserContent = Extract<Message, { role: "user" }>["content"];
export type PiImageContent = Extract<Exclude<UserContent, string>[number], { type: "image" }>;
export type AttachmentImages = ReadonlyMap<string, ReadonlyMap<string, PiImageContent>>;

/** Images are eligible in the newest three user messages, including the current prompt. */
const RECENT_USER_MESSAGES = 3;
const FILES_PER_KIND_PER_MESSAGE = 4;

/** Rebuild recent image inputs from their ACL-checked files, newest turn first. */
export async function loadAttachmentImages(
  messages: readonly UIMessage[],
  read: (uri: string, maxBytes: number) => Promise<ChatAttachmentContent | null>,
  signal: AbortSignal,
): Promise<AttachmentImages> {
  const result = new Map<string, Map<string, PiImageContent>>();
  let remaining = INLINE_IMAGE_BUDGET_BYTES;
  let turns = 0;
  for (
    let index = messages.length - 1;
    index >= 0 && turns < RECENT_USER_MESSAGES && remaining >= 4;
    index--
  ) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    turns++;
    const uris = new Set(
      message.parts.flatMap((part) =>
        part.type === "file" && isRasterImageMime(part.mediaType) ? [part.url] : [],
      ),
    );
    const images = new Map<string, PiImageContent>();
    for (const uri of [...uris].slice(0, FILES_PER_KIND_PER_MESSAGE)) {
      signal.throwIfAborted();
      const maxBytes = Math.min(RESOURCE_BLOB_MAX_BYTES, Math.floor(remaining / 4) * 3);
      if (!maxBytes) break;
      try {
        const file = await read(uri, maxBytes);
        if (!file || !isRasterImageMime(file.mime)) continue;
        const data = Buffer.from(file.bytes).toString("base64");
        remaining -= data.length;
        images.set(uri, { type: "image", data, mimeType: file.mime });
      } catch (error) {
        signal.throwIfAborted();
        logger.warn("chat image attachment skipped", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (images.size) result.set(message.id, images);
  }
  return result;
}

export type ReadAttachment = (
  uri: string,
  options: Pick<ChatAttachmentRead, "kind" | "maxBytes"> & { signal: AbortSignal },
) => Promise<ChatAttachmentContent | null>;

/**
 * Only a PDF explicitly attached to this prompt is sent. Later turns may use read_file
 * with the durable pointer, which checks the caller's current permissions again.
 */
export async function readPromptPdfs(
  message: UIMessage | undefined,
  pdfInput: TurnPdfInput,
  read: ReadAttachment | undefined,
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const receipts = new Map<string, string>();
  if (message?.role !== "user") return receipts;
  for (const part of message.parts) {
    if (part.type !== "file" || part.mediaType !== "application/pdf" || receipts.has(part.url))
      continue;
    signal.throwIfAborted();
    let note =
      "PDF content unavailable (unreadable or over the inline limit). Use an inline run to inspect larger files.";
    if (receipts.size >= FILES_PER_KIND_PER_MESSAGE) {
      note =
        "PDF omitted: at most four PDFs are read per message. Use an inline run to inspect it.";
    } else if (!pdfInput.supported) {
      note = PDF_INPUT_UNSUPPORTED;
    } else if (read) {
      try {
        const file = await read(part.url, {
          kind: "pdf",
          maxBytes: RESOURCE_BLOB_MAX_BYTES,
          signal,
        });
        if (file) {
          const pdf = pdfInput.add({
            name: part.filename ?? "attachment.pdf",
            data: Buffer.from(file.bytes).toString("base64"),
          });
          note = pdf.reference ?? pdf.note;
        }
      } catch (error) {
        signal.throwIfAborted();
        logger.warn("chat PDF attachment skipped", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    receipts.set(part.url, note);
  }
  return receipts;
}
