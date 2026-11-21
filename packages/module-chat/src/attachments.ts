// SPDX-License-Identifier: Apache-2.0

/**
 * Chat file attachments — the server-side lifecycle of a composer attachment.
 *
 * The composer uploads a file through the 2-step upload API and sends it as an
 * ai-SDK `file` part carrying an `upload://upl_x` URI (see `ui/upload.ts`).
 * Before the user turn is persisted or shown to the model, each `upload://` part
 * is materialized into a durable, chat-session-scoped file and its URI
 * rewritten to the stable `appfile://file_x` form (a chat session outlives the
 * ephemeral upload staging window, so only `appfile://` is ever stored).
 *
 * The model never sees raw file parts (an `upload://`/`appfile://` URL is not a
 * fetchable data URL): {@link messagesWithAttachmentsAsText} flattens each file
 * part into a compact, model-facing text line so the assistant can pass the
 * `appfile://` URI straight into a `run_and_wait` input file field. The pixels of
 * an image reach a vision model separately, as Pi image blocks next to that line
 * (`pi-chat/attachment-inputs.ts`); the line stays so the URI is still chainable.
 */

import type { FileUIPart, UIMessage, UIMessageChunk } from "ai";
import type { ResolvedChatAttachment } from "@appstrate/core/chat-contract";
import { parseFileUri, UPLOAD_URI_PREFIX } from "@appstrate/core/file-uri";
import { formatBytes } from "@appstrate/core/format";
import { isImageMime } from "@appstrate/core/mime";
import type { FileDelivery } from "./file-input.ts";
import { UNNAMED_FILE } from "./ui/run-events.ts";

/** Is `part` an ai-SDK `file` part? */
function isFileUIPart(part: unknown): part is FileUIPart {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "file" &&
    typeof (part as { url?: unknown }).url === "string"
  );
}

/** The `{appstrate: {size}}` metadata the rewrite stamps onto a materialized part. */
function partSize(part: FileUIPart): number | null {
  const size = (part.providerMetadata?.appstrate as { size?: unknown } | undefined)?.size;
  return typeof size === "number" && Number.isFinite(size) ? size : null;
}

/**
 * The model-facing line for one file part — English (it reaches the model), e.g.
 * `[Attached file: rapport.pdf — appfile://file_abc123 — application/pdf, 2.3 MB]`.
 * Size is included when the materialized part carries it.
 */
function attachmentTextBlock(part: FileUIPart, imageNote: string): string {
  // Same nameless-file fallback the chips render, so the line the model reads
  // names the attachment exactly as the user sees it named.
  const name = part.filename ?? UNNAMED_FILE;
  const size = partSize(part);
  const sizeSuffix = size !== null ? `, ${formatBytes(size)}` : "";
  return `[Attached file: ${name} — ${part.url} — ${part.mediaType}${sizeSuffix}${imageNote}]`;
}

/** What the pointer line of an image says about its pixels, so the model never guesses at them. */
interface AttachmentContext {
  pdfReceipts?: ReadonlyMap<string, string>;
  /** What this turn sends the model (`fileDelivery`). */
  fileDelivery: FileDelivery;
  /** The user messages' image parts whose pixels ride this request, by message id then URI. */
  sent: ReadonlyMap<string, ReadonlyMap<string, unknown>>;
}

function imageNote(
  message: UIMessage,
  part: FileUIPart,
  context: AttachmentContext | undefined,
): string {
  if (!context || !isImageMime(part.mediaType)) return "";
  if (!context.fileDelivery.image) {
    return " — you cannot view images with this model: say so rather than guess its content";
  }
  return context.sent.get(message.id)?.has(part.url)
    ? ""
    : " — its pixels are not part of this request (too old, too large or an unsupported format): say so rather than guess its content";
}

/**
 * Return a copy of the thread with every file part replaced by a compact text
 * part (the {@link attachmentTextBlock}) so the model sees the attachment as
 * text it can act on. Messages without file parts are returned unchanged (no
 * copy). Used when projecting the thread into the engine's transcript so the model-facing serialization lives in one place.
 */
export function messagesWithAttachmentsAsText(
  messages: UIMessage[],
  context?: AttachmentContext,
): UIMessage[] {
  return messages.map((message) => {
    const parts = message.parts;
    if (message.role !== "user" || !parts?.some(isFileUIPart)) return message;
    return {
      ...message,
      parts: parts.map((part) =>
        isFileUIPart(part)
          ? {
              type: "text" as const,
              text: [
                attachmentTextBlock(part, imageNote(message, part, context)),
                message === messages[messages.length - 1] && part.mediaType === "application/pdf"
                  ? context?.pdfReceipts?.get(part.url)
                  : undefined,
              ]
                .filter(Boolean)
                .join("\n"),
            }
          : part,
      ),
    };
  });
}

/**
 * Materialize the `upload://`/`appfile://` file parts of one user message into
 * durable files, rewriting each part's URI to the stable `appfile://` form
 * and stamping the authoritative size (from the file row) and the space it
 * lives in into `providerMetadata.appstrate` (`size`, `spaceId`) so downstream
 * rendering, the file's download and the model-facing block can use them. Non-file parts pass through untouched; a message with no
 * file parts is returned as-is (the `resolve` seam is never called).
 *
 * `resolve` is injected (the platform file service) so this stays free of
 * any apps/api import and is unit-testable with the real service or a stub.
 * Sequential on purpose: each materialization takes the org quota row `FOR
 * UPDATE`, so concurrent calls would serialize on that lock anyway.
 */
export async function materializeUserAttachments(
  message: UIMessage,
  resolve: (uri: string) => Promise<ResolvedChatAttachment>,
): Promise<UIMessage> {
  const parts = message.parts;
  if (!parts?.some(isFileUIPart)) return message;

  const rewritten: UIMessage["parts"] = [];
  for (const part of parts) {
    if (!isFileUIPart(part)) {
      rewritten.push(part);
      continue;
    }
    const resolved = await resolve(part.url);
    rewritten.push({
      ...part,
      url: resolved.uri,
      mediaType: resolved.mime,
      filename: resolved.name,
      providerMetadata: {
        ...part.providerMetadata,
        appstrate: { size: resolved.size, spaceId: resolved.spaceId },
      },
    } satisfies FileUIPart);
  }
  return { ...message, parts: rewritten };
}

/** UI-stream data part naming the stored file each just-sent `upload://` became. */
export const UPLOAD_RESOLUTIONS_PART = "data-upload-resolutions";

/** One entry of {@link UPLOAD_RESOLUTIONS_PART}: the sent URI and the file it resolved to. */
export interface UploadResolution {
  uri: string;
  file: { id: string; spaceId: string };
}

/**
 * The chunk telling the browser how the `upload://` parts of `sent` resolved in
 * `materialized` (its {@link materializeUserAttachments} rewrite, part for part),
 * or `null` when the turn sent none. The browser still holds the optimistic
 * `upload://` copy of the message; this is what makes its chips previewable
 * before a reload. Transient: it is about the user message, never a part of the
 * assistant's.
 */
export function uploadResolutionsChunk(
  sent: UIMessage,
  materialized: UIMessage,
): UIMessageChunk | null {
  const resolutions: UploadResolution[] = [];
  sent.parts?.forEach((part, index) => {
    const rewritten = materialized.parts[index];
    if (!isFileUIPart(part) || !part.url.startsWith(UPLOAD_URI_PREFIX)) return;
    if (!isFileUIPart(rewritten)) return;
    const id = parseFileUri(rewritten.url);
    const spaceId = (rewritten.providerMetadata?.appstrate as { spaceId?: unknown } | undefined)
      ?.spaceId;
    if (id && typeof spaceId === "string") {
      resolutions.push({ uri: part.url, file: { id, spaceId } });
    }
  });
  if (resolutions.length === 0) return null;
  return { type: UPLOAD_RESOLUTIONS_PART, data: resolutions, transient: true };
}

/**
 * The thread with the file parts of each message before the last replaced by its stored
 * row's (`stored`, by message id), where the message held its first file part. The browser
 * submits the history it holds, whose file parts can still name the `upload://` it sent
 * (only the stored row was rewritten to `appfile://`), or anything else: the stored row is
 * the one source of an earlier message's files.
 */
export function withStoredHistoryFiles(
  messages: UIMessage[],
  stored: ReadonlyMap<string, FileUIPart[]>,
): UIMessage[] {
  return messages.map((message, index) => {
    if (index === messages.length - 1) return message;
    const files = stored.get(message.id) ?? [];
    const parts = message.parts ?? [];
    if (!files.length && !parts.some((part) => part.type === "file")) return message;
    let placed = false;
    const rebuilt = parts.flatMap<UIMessage["parts"][number]>((part) => {
      if (part.type !== "file") return [part];
      if (placed) return [];
      placed = true;
      return files;
    });
    return { ...message, parts: placed ? rebuilt : [...rebuilt, ...files] };
  });
}
