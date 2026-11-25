// SPDX-License-Identifier: Apache-2.0

/**
 * How a client shows one MCP tool call: what it did, to what, and whether it wrote. The platform
 * stamps it on every tool result under `_meta["dev.appstrate/presentation"]`, from what only the
 * server knows (the operation's OpenAPI method and tag, the integration behind a proxied tool and
 * the hints its server declares), so a client never guesses from a tool name or an id. `_meta`
 * never reaches the model: it reads `content` alone.
 */

import { z } from "zod";

export const TOOL_PRESENTATION_META_KEY = "dev.appstrate/presentation";

/** The entity a call acted on, or one a search listed. */
export const presentationSubjectSchema = z.object({
  kind: z.enum(["integration", "agent", "skill", "package", "user"]),
  /** Package id (`@scope/name`), or the user's id. */
  id: z.string().min(1),
  display_name: z.string().min(1).optional(),
  /** An integration's manifest icon: an Iconify id or an image URL. */
  icon: z.string().min(1).optional(),
});

export type PresentationSubject = z.infer<typeof presentationSubjectSchema>;

/** Subjects a search lists in its presentation, at most. */
export const MAX_PRESENTED_ITEMS = 8;

export const toolPresentationSchema = z.object({
  /**
   * What the call does, as its source names it: the operation's OpenAPI `summary`, the title the
   * integration's server gives its tool, else the tool's own title. English, as the source is.
   */
  title: z.string().min(1),
  /** The call reads only (MCP `readOnlyHint`, an HTTP `GET`/`HEAD`). */
  read_only: z.boolean(),
  /** The call may delete or overwrite (an HTTP `DELETE`, a server's explicit `destructiveHint`). */
  destructive: z.boolean(),
  /** `invoke_operation`: the operation's first OpenAPI tag and its HTTP method. */
  tag: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  subject: presentationSubjectSchema.optional(),
  /** `search`: how many items it found, and the distinct subjects of the first ones shown. */
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

/** HTTP methods that only read. */
export function isReadOnlyMethod(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === "GET" || upper === "HEAD";
}
