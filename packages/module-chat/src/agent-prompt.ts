// SPDX-License-Identifier: Apache-2.0

// A composer agent launch as a user-message part: the browser sends `{ name, title }` (a prompt of
// `prompts/list`); the turn stores its `prompts/get` instructions as `text`, which the model reads.

import { z } from "zod";

export const AGENT_PROMPT_PART_TYPE = "data-agent-prompt";

export const agentPromptDataSchema = z.strictObject({
  name: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  /** Written by the turn that resolves it; absent on what the browser sends. */
  text: z.string().optional(),
});

/** The first agent-prompt part of `parts` and its data; `null` when none parses. */
export function agentPromptOfParts<P>(
  parts: readonly P[] | undefined,
): { part: P; data: z.infer<typeof agentPromptDataSchema> } | null {
  const part = parts?.find(
    (candidate) => (candidate as { type?: unknown } | null)?.type === AGENT_PROMPT_PART_TYPE,
  );
  const data = agentPromptDataSchema.safeParse((part as { data?: unknown } | undefined)?.data);
  return part !== undefined && data.success ? { part, data: data.data } : null;
}
