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

/** `context` as request headers; without one the client's middleware sends the current scope. */
export function fileContextHeader(context: FileContext | undefined) {
  return context && { "X-Org-Id": context.orgId, "X-Space-Id": context.spaceId };
}
