// SPDX-License-Identifier: Apache-2.0

/**
 * Chat file attachments — the server-side lifecycle of a composer attachment.
 *
 * The composer uploads a file through the 2-step upload API and sends it as an
 * ai-SDK `file` part carrying an `upload://upl_x` URI (see `ui/upload.ts`).
 * Before the user turn is persisted or shown to the model, each `upload://` part
 * is materialized into a durable, chat-session-scoped file and its URI
 * rewritten to the stable `appfile://doc_x` form (a chat session outlives the
 * ephemeral upload staging window, so only `appfile://` is ever stored).
 *
 * The model never sees raw file parts (an `upload://`/`appfile://` URL is not a
 * fetchable data URL): {@link messagesWithAttachmentsAsText} flattens each file
 * part into a compact, model-facing text line so the assistant can pass the
 * `appfile://` URI straight into a `run_and_wait` input file field.
 */

import type { FileUIPart, UIMessage } from "ai";
import type { ResolvedChatAttachment } from "@appstrate/core/chat-contract";
import { formatBytes } from "@appstrate/core/format";
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
 * `[Attached file: rapport.pdf — appfile://doc_abc123 — application/pdf, 2.3 MB]`.
 * Size is included when the materialized part carries it.
 */
function attachmentTextBlock(part: FileUIPart): string {
  // Same nameless-file fallback the chips render, so the line the model reads
  // names the attachment exactly as the user sees it named.
  const name = part.filename ?? UNNAMED_FILE;
  const size = partSize(part);
  const sizeSuffix = size !== null ? `, ${formatBytes(size)}` : "";
  return `[Attached file: ${name} — ${part.url} — ${part.mediaType}${sizeSuffix}]`;
}

/**
 * Return a copy of the thread with every file part replaced by a compact text
 * part (the {@link attachmentTextBlock}) so the model sees the attachment as
 * text it can act on. Messages without file parts are returned unchanged (no
 * copy). Used when projecting the thread into the engine's transcript so the model-facing serialization lives in one place.
 */
export function messagesWithAttachmentsAsText(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    const parts = message.parts;
    if (!parts?.some(isFileUIPart)) return message;
    return {
      ...message,
      parts: parts.map((part) =>
        isFileUIPart(part) ? { type: "text" as const, text: attachmentTextBlock(part) } : part,
      ),
    };
  });
}

/**
 * Materialize the `upload://`/`appfile://` file parts of one user message into
 * durable files, rewriting each part's URI to the stable `appfile://` form
 * and stamping the authoritative size (from the file row) into
 * `providerMetadata.appstrate.size` so downstream rendering and the model-facing
 * block can show it. Non-file parts pass through untouched; a message with no
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
      providerMetadata: { ...part.providerMetadata, appstrate: { size: resolved.size } },
    } satisfies FileUIPart);
  }
  return { ...message, parts: rewritten };
}
