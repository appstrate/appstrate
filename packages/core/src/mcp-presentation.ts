// SPDX-License-Identifier: Apache-2.0

/**
 * How a client shows one MCP tool call: what it did and to what. The platform's MCP server stamps
 * it on every result of its tools under `_meta["dev.appstrate/presentation"]`, from what only the
 * server knows (the operation's OpenAPI method and tag, the integration behind a proxied tool), so
 * a client never guesses from a tool name or an id. Display data only: a result's `content` is
 * unchanged, and a client that forwards `_meta` to a model forwards this too.
 */

import { z } from "zod";

export const TOOL_PRESENTATION_META_KEY = "dev.appstrate/presentation";

const presentationSubjectSchema = z.object({
  kind: z.enum(["integration", "agent", "skill", "user"]),
  /** Package id (`@scope/name`), or the user's id. */
  id: z.string().min(1),
  display_name: z.string().min(1).optional(),
  /** An integration's manifest icon: an Iconify id or an image URL. */
  icon: z.string().min(1).optional(),
});

/** The entity a call acted on, or one a search listed. */
export type PresentationSubject = z.infer<typeof presentationSubjectSchema>;

/** Subjects a search lists in its presentation, at most. */
export const MAX_PRESENTED_ITEMS = 8;

export const toolPresentationSchema = z.object({
  /**
   * What the call does, a fixed label, never the call's arguments: the tool's title (else its
   * name), an operation's OpenAPI `summary`, a third-party server's title for its tool.
   */
  title: z.string().min(1),
  /** `invoke_operation`: the operation's first OpenAPI tag. */
  tag: z.string().min(1).optional(),
  /**
   * The HTTP method: an operation's, or that of an integration `api_call` holding one request
   * (none for a batch of several).
   */
  method: z.string().min(1).optional(),
  subject: presentationSubjectSchema.optional(),
  /**
   * `search`: the sum of its sections' `total`, what each kind matched before `limit`: an agent
   * or an integration tool once, an operation once when the caller may invoke it (one denied is
   * not counted), a skill once per space it is listed in. `items`: the distinct subjects (kind and
   * id) its shown items name, in order, at most {@link MAX_PRESENTED_ITEMS}.
   */
  count: z.number().int().nonnegative().optional(),
  items: z.array(presentationSubjectSchema).max(MAX_PRESENTED_ITEMS).optional(),
});

export type ToolPresentation = z.infer<typeof toolPresentationSchema>;

/** The presentation a result's `_meta` carries; `undefined` when it carries none or a malformed one. */
export function readToolPresentation(meta: unknown): ToolPresentation | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const parsed = toolPresentationSchema.safeParse(
    (meta as Record<string, unknown>)[TOOL_PRESENTATION_META_KEY],
  );
  return parsed.success ? parsed.data : undefined;
}

/**
 * On a tool descriptor: its calls only look things up for the person reading them, although
 * `readOnlyHint` is withheld for a side effect outside the caller's data (a third-party catalog
 * read that may refresh a token). Known before a call runs, so a client can fold such calls.
 */
export const TOOL_LOOKUP_META_KEY = "dev.appstrate/lookup";

/** A tool whose calls only look things up: declared `readOnlyHint`, or stamped a lookup. */
export function isLookupTool(descriptor: {
  annotations?: { readOnlyHint?: boolean } | undefined;
  _meta?: Record<string, unknown> | undefined;
}): boolean {
  return (
    descriptor.annotations?.readOnlyHint === true ||
    descriptor._meta?.[TOOL_LOOKUP_META_KEY] === true
  );
}
