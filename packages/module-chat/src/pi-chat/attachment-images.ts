// SPDX-License-Identifier: Apache-2.0

/**
 * Which attached images a chat turn shows to the model, and in what shape.
 *
 * The transcript stores only the `appfile://` pointer of an attachment, never
 * its bytes (no base64 in the persisted conversation). A model that accepts
 * images gets the pixels of the most recent attachments rebuilt from the file
 * at turn time; everything else stays the pointer line, so the `appfile://` URI
 * can still be chained into a run and an old turn never bloats the request.
 *
 * Every figure below bounds what ONE provider request carries, since each turn
 * re-sends the replayed history.
 */

import type { UIMessage } from "ai";
import type { ChatImageContent } from "@appstrate/core/chat-contract";
import type { Message } from "@appstrate/runner-pi";
import { logger } from "../logger.ts";

type UserContent = Extract<Message, { role: "user" }>["content"];
/** A Pi image block, as a user turn carries it. */
export type PiImageContent = Extract<Exclude<UserContent, string>[number], { type: "image" }>;

/** The image blocks to send, by user message id then by the part's `appfile://` URI. */
export type AttachmentImages = ReadonlyMap<string, ReadonlyMap<string, PiImageContent>>;

/** Newest user messages carrying images whose pixels are re-sent; older ones keep the pointer line. */
export const ATTACHMENT_IMAGE_TURNS = 3;
/** Images sent per user message; the rest keep the pointer line. */
export const ATTACHMENT_IMAGES_PER_MESSAGE = 4;
/** Stored size above which a file is not read (the resize would be the cost, not the model). */
export const ATTACHMENT_IMAGE_SOURCE_MAX_BYTES = 10 * 1024 * 1024;
/** Longest edge, in pixels, an image is downscaled to: past it a provider downsizes it anyway. */
export const ATTACHMENT_IMAGE_MAX_EDGE = 1568;
/** Base64 bytes one image may weigh once downscaled. */
export const ATTACHMENT_IMAGE_ENCODED_MAX_BYTES = 1.5 * 1024 * 1024;
/** Base64 bytes of every image one request carries, replayed turns included. */
export const ATTACHMENT_IMAGES_REQUEST_MAX_BYTES = 6 * 1024 * 1024;

export interface AttachmentImageDeps {
  /** The platform read (`PlatformServices.readChatImage`): `null` for a file that cannot be sent. */
  read(uri: string): Promise<ChatImageContent | null>;
  /** Downscale to the limits above; `null` when it cannot be brought under them. */
  resize(bytes: Uint8Array, mime: string): Promise<{ data: string; mimeType: string } | null>;
}

function imageParts(message: UIMessage): { url: string }[] {
  return message.parts.flatMap((part) =>
    part.type === "file" && part.mediaType.startsWith("image/") ? [{ url: part.url }] : [],
  );
}

/**
 * Read, downscale and budget the images of the newest user messages. Walks from
 * the newest message back, so the turn being answered always wins the budget; a
 * file that cannot be read or fitted is skipped (its pointer line stays) and
 * never fails the turn.
 */
export async function loadAttachmentImages(
  messages: readonly UIMessage[],
  deps: AttachmentImageDeps,
): Promise<AttachmentImages> {
  const result = new Map<string, Map<string, PiImageContent>>();
  let remaining = ATTACHMENT_IMAGES_REQUEST_MAX_BYTES;
  let turns = 0;

  for (let i = messages.length - 1; i >= 0 && turns < ATTACHMENT_IMAGE_TURNS; i--) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    const parts = imageParts(message);
    if (parts.length === 0) continue;
    turns += 1;

    const sent = new Map<string, PiImageContent>();
    for (const { url } of parts.slice(0, ATTACHMENT_IMAGES_PER_MESSAGE)) {
      if (sent.has(url)) continue;
      try {
        const file = await deps.read(url);
        if (!file) continue;
        const resized = await deps.resize(Buffer.from(file.data, "base64"), file.mime);
        if (!resized || resized.data.length > remaining) continue;
        remaining -= resized.data.length;
        sent.set(url, { type: "image", data: resized.data, mimeType: resized.mimeType });
      } catch (error) {
        logger.warn("chat attachment image skipped", {
          url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (sent.size > 0) result.set(message.id, sent);
  }
  return result;
}
