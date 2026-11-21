// SPDX-License-Identifier: Apache-2.0

import type { UIMessage } from "ai";
import { INLINE_RUN_HINT, type TurnPdfInput } from "./native-pdf.ts";
import type { ChatAttachmentRead, ChatAttachmentContent } from "@appstrate/core/chat-contract";
import { isRasterImageMime } from "@appstrate/core/mime";
import { RESOURCE_BLOB_MAX_BYTES } from "@appstrate/mcp-transport";
import { INLINE_IMAGE_BUDGET_BYTES, type Message } from "@appstrate/runner-pi";
import { logger } from "../logger.ts";

type UserContent = Extract<Message, { role: "user" }>["content"];
export type PiImageContent = Extract<Exclude<UserContent, string>[number], { type: "image" }>;
export type AttachmentImages = ReadonlyMap<string, ReadonlyMap<string, PiImageContent>>;

/**
 * Base64 bytes of binary input one chat request may carry, in all: under the llm-proxy's default
 * request cap (`LLM_PROXY_LIMITS.max_request_bytes`, 10 MiB) with room left for the text of the
 * conversation. The three kinds of binary share it, each bounded on its own path:
 * - tool-result images: {@link INLINE_IMAGE_BUDGET_BYTES}, by the runner's `inlineImageBudgetExtension`;
 * - PDFs: {@link RESOURCE_BLOB_MAX_BYTES} raw per turn, by `createTurnPdfInput`;
 * - attachment images: what is left, {@link ATTACHMENT_IMAGE_BUDGET_BYTES}.
 */
export const REQUEST_BINARY_BUDGET_BYTES = 7 * 1024 * 1024;

/** Base64 size of `bytes` raw bytes. */
const base64Size = (bytes: number) => Math.ceil(bytes / 3) * 4;

/** The attachment images' share of {@link REQUEST_BINARY_BUDGET_BYTES}. */
export const ATTACHMENT_IMAGE_BUDGET_BYTES =
  REQUEST_BINARY_BUDGET_BYTES - INLINE_IMAGE_BUDGET_BYTES - base64Size(RESOURCE_BLOB_MAX_BYTES);

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
  let remaining = ATTACHMENT_IMAGE_BUDGET_BYTES;
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
 * Only a PDF explicitly attached to this prompt is sent. Later turns may use read
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
    let note = `PDF content unavailable (unreadable or over the inline limit). ${INLINE_RUN_HINT}`;
    // A model that reads no PDF says so for every one; the per-message cap applies only when it does.
    if (pdfInput.unsupported) {
      note = pdfInput.unsupported;
    } else if (receipts.size >= FILES_PER_KIND_PER_MESSAGE) {
      note = `PDF omitted: at most ${FILES_PER_KIND_PER_MESSAGE} per message. ${INLINE_RUN_HINT}`;
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
          note = "reference" in pdf ? pdf.reference : pdf.note;
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
