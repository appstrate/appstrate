// SPDX-License-Identifier: Apache-2.0

import type { z } from "zod";
import { AGENT_PROMPT_PART_TYPE, agentPromptDataSchema } from "@appstrate/core/chat-message";

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
