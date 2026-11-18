// SPDX-License-Identifier: Apache-2.0

/**
 * Composer upload staging. The 2-step upload protocol itself (descriptor +
 * PUT to the sink) belongs to the host and arrives through the `uploadFile`
 * injection — the module adds two chat-specific caches on top: the staged-image
 * previews, and the stored file each sent upload resolved to.
 */

import type { UploadFile } from "./runtime-context.ts";
import { z } from "zod";
import { UPLOAD_RESOLUTIONS_PART, type UploadResolution } from "../attachments.ts";

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
 * Stage `file` into `spaceId` through the host uploader and return its `upload://` URI,
 * remembering a local preview when the file is an image. Transport failures
 * propagate from the host implementation (the composer surfaces the message).
 */
export async function stageComposerFile(
  upload: UploadFile,
  file: File,
  spaceId: string,
): Promise<string> {
  const uri = await upload(file, spaceId);
  if (file.type.startsWith("image/")) {
    stagedImagePreviews.set(uri, URL.createObjectURL(file));
  }
  return uri;
}

/**
 * `upload://` URI → the stored file the server materialized it into, as the turn's
 * stream reports it (`data-upload-resolutions`). The sent message keeps its
 * optimistic `upload://` parts until a reload; this is what lets its chips open
 * the file meanwhile. Same lifetime as {@link stagedImagePreviews}. Replaced, not
 * mutated, so the map itself is the `useSyncExternalStore` snapshot.
 */
let resolvedUploads: ReadonlyMap<string, UploadResolution["file"]> = new Map();
const resolvedUploadListeners = new Set<() => void>();

const uploadResolutionsSchema = z.array(
  z.object({ uri: z.string(), file: z.object({ id: z.string(), spaceId: z.string() }) }),
) satisfies z.ZodType<UploadResolution[]>;

/**
 * `useChat`'s `onData`: record the resolutions a turn's stream carried and
 * re-render the chips reading them. Any other data part is not ours.
 */
export function recordUploadResolutions(part: { type: string; data: unknown }): void {
  if (part.type !== UPLOAD_RESOLUTIONS_PART) return;
  const parsed = uploadResolutionsSchema.safeParse(part.data);
  if (!parsed.success) return;
  const next = new Map(resolvedUploads);
  for (const { uri, file } of parsed.data) next.set(uri, file);
  resolvedUploads = next;
  for (const listener of resolvedUploadListeners) listener();
}

/** `useSyncExternalStore` pair over the resolved uploads. */
export function subscribeResolvedUploads(listener: () => void): () => void {
  resolvedUploadListeners.add(listener);
  return () => resolvedUploadListeners.delete(listener);
}
export function resolvedUploadsSnapshot(): ReadonlyMap<string, UploadResolution["file"]> {
  return resolvedUploads;
}
