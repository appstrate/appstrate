// SPDX-License-Identifier: Apache-2.0

/**
 * Composer upload staging. The 2-step upload protocol itself (descriptor +
 * PUT to the sink) belongs to the host and arrives through the `uploadFile`
 * injection — the module adds exactly one thing on top: the staged-image
 * preview cache, which is chat-specific.
 */

import type { UploadFile } from "./runtime-context.ts";

/**
 * `upload://` URI → local object URL for images staged this session. Sent-message
 * attachments are rebuilt from the message's file parts by the react-ai-sdk
 * converter, so the picked `File` is no longer reachable at render time — this
 * cache is the only way to show a just-sent image before its `appfile://` form
 * lands on reload. Session-scoped by design: a handful of object URLs, reclaimed
 * with the page (an upload URI is single-shot, so entries are never re-keyed).
 */
const stagedImagePreviews = new Map<string, string>();

/** Local preview URL for a staged `upload://` URI, if it was an image. */
export function stagedImagePreviewUrl(uri: string): string | undefined {
  return stagedImagePreviews.get(uri);
}

/**
 * Stage `file` through the host uploader and return its `upload://` URI,
 * remembering a local preview when the file is an image. Transport failures
 * propagate from the host implementation (the composer surfaces the message).
 */
export async function stageComposerFile(upload: UploadFile, file: File): Promise<string> {
  const uri = await upload(file);
  if (file.type.startsWith("image/")) {
    stagedImagePreviews.set(uri, URL.createObjectURL(file));
  }
  return uri;
}
