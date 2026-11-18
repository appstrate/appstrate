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
import { loadPiCodingAgentSdk, type Message } from "@appstrate/runner-pi";
import { logger } from "../logger.ts";
import { isDecodable } from "./image-dimensions.ts";

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
const ATTACHMENT_IMAGE_MAX_EDGE = 1568;
/** Base64 bytes one image may weigh once downscaled. */
const ATTACHMENT_IMAGE_ENCODED_MAX_BYTES = 1.5 * 1024 * 1024;
/** Base64 bytes of every image one request carries, replayed turns included. */
export const ATTACHMENT_IMAGES_REQUEST_MAX_BYTES = 6 * 1024 * 1024;

/** Downscale to the limits above; `null` when it cannot be brought under them. */
export type ImageResizer = (
  bytes: Uint8Array,
  mime: string,
) => Promise<{ data: string; mimeType: string } | null>;

/**
 * The one resizer every image bound for a provider goes through, an attachment or a tool result:
 * Pi's `resizeImage` (Photon, in a worker) at the limits above, after a header check that refuses
 * an image declaring more than 40 megapixels (or a header it cannot read).
 */
export const resizeWithPi: ImageResizer = async (bytes, mime) => {
  // Refused before Pi decodes it: the stored size says nothing about the decoded one.
  if (!isDecodable(bytes)) return null;
  const sdk = await loadPiCodingAgentSdk();
  const resized = await sdk.resizeImage(bytes, mime, {
    maxWidth: ATTACHMENT_IMAGE_MAX_EDGE,
    maxHeight: ATTACHMENT_IMAGE_MAX_EDGE,
    maxBytes: ATTACHMENT_IMAGE_ENCODED_MAX_BYTES,
  });
  return resized && { data: resized.data, mimeType: resized.mimeType };
};

export interface AttachmentImageDeps {
  /** The platform read (`PlatformServices.readChatImage`): `null` for a file that cannot be sent. */
  read(uri: string): Promise<ChatImageContent | null>;
  resize: ImageResizer;
}

/** Base64 bytes of the images the tools of ONE turn may put in front of the model, in all. */
export const TOOL_IMAGES_TURN_MAX_BYTES = 4 * 1024 * 1024;

/** What is left of a turn's tool-image budget; shared by every tool of the turn. */
export interface ToolImageBudget {
  remaining: number;
}

type ToolContentBlock =
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/**
 * Bring the image blocks of a tool result under the provider's limits: each is downscaled like an
 * attachment, and charged to the turn's budget ({@link TOOL_IMAGES_TURN_MAX_BYTES}), so a model
 * that chains `read_file` calls cannot grow the request without bound. An image that cannot be
 * downscaled, or that no longer fits the budget, becomes a text pointer saying so.
 */
export async function fitToolImages(
  content: readonly ToolContentBlock[],
  budget: ToolImageBudget,
  resize: ImageResizer,
): Promise<ToolContentBlock[]> {
  const fitted: ToolContentBlock[] = [];
  for (const block of content) {
    if (block.type !== "image") {
      fitted.push(block);
      continue;
    }
    let resized: Awaited<ReturnType<ImageResizer>> = null;
    try {
      resized = await resize(Buffer.from(block.data, "base64"), block.mimeType);
    } catch (error) {
      logger.warn("chat tool image skipped", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (resized && resized.data.length <= budget.remaining) {
      budget.remaining -= resized.data.length;
      fitted.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
    } else {
      fitted.push({
        type: "text",
        text: `[image ${block.mimeType} — not shown: it could not be downscaled to the provider's limits, or this turn's image budget is spent]`,
      });
    }
  }
  return fitted;
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
