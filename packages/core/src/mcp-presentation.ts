// SPDX-License-Identifier: Apache-2.0

/**
 * How a client shows one MCP tool call, from what only the server knows: stamped on a platform
 * tool's result under `_meta["dev.appstrate/presentation"]`. Display data only: `content` is
 * unchanged.
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

export const MAX_PRESENTED_ITEMS = 8;

export const toolPresentationSchema = z.object({
  /** A remote integration tool's title on its server, else its name there. */
  title: z.string().min(1).optional(),
  /** `invoke_operation`: the operation's first OpenAPI tag. */
  tag: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  subject: presentationSubjectSchema.optional(),
  /** `search`: the sum of its sections' `total`, and the distinct subjects its items name. */
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
 * On a descriptor whose `readOnlyHint` is withheld for a side effect outside the caller's data (a
 * third-party catalog read): its calls only look things up.
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
