// SPDX-License-Identifier: Apache-2.0

/**
 * The file reader's address (`/files/:fileId?org=…&space=…`). The link names the
 * organization and space the file is read in, so it opens whatever the current
 * context is, without changing it.
 */

export interface FileContext {
  orgId: string;
  spaceId: string;
}

export function fileReaderPath(fileId: string, context: FileContext): string {
  const query = new URLSearchParams({ org: context.orgId, space: context.spaceId });
  return `/files/${encodeURIComponent(fileId)}?${query.toString()}`;
}

/** The shareable link. Call it on click: the origin is a browser fact. */
export function fileReaderUrl(fileId: string, context: FileContext): string {
  return `${window.location.origin}${fileReaderPath(fileId, context)}`;
}

/** The context a reader address names; none unless it names both halves. */
export function readerContext(params: URLSearchParams): FileContext | undefined {
  const orgId = params.get("org");
  const spaceId = params.get("space");
  return orgId && spaceId ? { orgId, spaceId } : undefined;
}

/**
 * The context a file of `spaceId` is read in: its own space when the reader stands in another
 * (a list spanning spaces); none for a file of the current space, or before there is one.
 */
export function otherSpaceFileContext(
  spaceId: string | undefined,
  orgId: string | null,
  currentSpaceId: string | null,
): FileContext | undefined {
  return spaceId && orgId && currentSpaceId && spaceId !== currentSpaceId
    ? { orgId, spaceId }
    : undefined;
}

/** `context` as request headers; without one the client's middleware sends the current scope. */
export function fileContextHeader(context: FileContext | undefined) {
  return context && { "X-Org-Id": context.orgId, "X-Space-Id": context.spaceId };
}
