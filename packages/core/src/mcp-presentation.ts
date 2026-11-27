// SPDX-License-Identifier: Apache-2.0

/**
 * How a client shows one MCP tool call, from what only the server knows: stamped on a platform
 * tool's result under `_meta["dev.appstrate/presentation"]`. Display data only: `content` is
 * unchanged.
 */

import { z } from "zod";

export const TOOL_PRESENTATION_META_KEY = "dev.appstrate/presentation";

/** An MCP `Icon` (`Tool.icons`): where the image is, and when a client should draw it. */
const presentationIconSchema = z.object({
  src: z.string().min(1),
  mimeType: z.string().min(1).optional(),
  sizes: z.array(z.string().min(1)).optional(),
  theme: z.enum(["light", "dark"]).optional(),
});

export type PresentationIcon = z.infer<typeof presentationIconSchema>;

const presentationSubjectSchema = z.object({
  kind: z.enum(["integration", "agent", "skill", "user"]),
  /** Package id (`@scope/name`), or the user's id. */
  id: z.string().min(1),
  display_name: z.string().min(1).optional(),
  /** An integration's logo, one image per theme at most. */
  icons: z.array(presentationIconSchema).min(1).optional(),
});

/** The entity a call acted on, or one a search listed. */
export type PresentationSubject = z.infer<typeof presentationSubjectSchema>;

export const MAX_PRESENTED_ITEMS = 8;

/**
 * What kind of call a result answers, with only the fields that kind has. `call` names the variant:
 * a client switches on it, never on a tool's name.
 */
export const toolPresentationSchema = z.discriminatedUnion("call", [
  /** `invoke_operation`: the operation's first OpenAPI tag, its method and the package its path aims at. */
  z.object({
    call: z.literal("operation"),
    tag: z.string().min(1).optional(),
    method: z.string().min(1),
    subject: presentationSubjectSchema.optional(),
  }),
  /** `call_integration_tool` of an `{ns}__api_call`: the method when it holds one request, and how many it holds. */
  z.object({
    call: z.literal("proxied_request"),
    method: z.string().min(1).optional(),
    /** The batch size; absent when the arguments carry no readable `requests` array. */
    requests: z.number().int().min(1).optional(),
    subject: presentationSubjectSchema,
  }),
  /** `call_integration_tool` of a remote server's tool: its title there, else its name there. */
  z.object({
    call: z.literal("remote_tool"),
    title: z.string().min(1),
    subject: presentationSubjectSchema,
  }),
  /** `search`: the sum of its sections' `total`, and the distinct subjects its items name. */
  z.object({
    call: z.literal("search"),
    count: z.number().int().nonnegative(),
    items: z.array(presentationSubjectSchema).max(MAX_PRESENTED_ITEMS),
  }),
  /** `get_me`: the caller it answered for. */
  z.object({
    call: z.literal("caller"),
    subject: presentationSubjectSchema,
  }),
]);

export type ToolPresentation = z.infer<typeof toolPresentationSchema>;

/** The presentation a result's `_meta` carries; `undefined` when it carries none or a malformed one (an Appstrate result without `call` included). */
export function readToolPresentation(meta: unknown): ToolPresentation | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const parsed = toolPresentationSchema.safeParse(
    (meta as Record<string, unknown>)[TOOL_PRESENTATION_META_KEY],
  );
  return parsed.success ? parsed.data : undefined;
}

/** A tool whose calls only look things up: it declares the standard `readOnlyHint`. */
export function isLookupTool(descriptor: {
  annotations?: { readOnlyHint?: boolean } | undefined;
}): boolean {
  return descriptor.annotations?.readOnlyHint === true;
}
