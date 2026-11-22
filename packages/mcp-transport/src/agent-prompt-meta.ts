// SPDX-License-Identifier: Apache-2.0

/**
 * The `_meta` an Appstrate platform server puts on each agent launch prompt of `prompts/list`.
 * MCP's own `icons` field takes image URLs; an agent's icon is a token of the
 * `@appstrate/core/appearance` grammar (`lucide:bot`), so it travels here, under a reverse-DNS
 * key like the other `dev.appstrate/*` markers. Shared by the server that writes it
 * (`apps/api`'s mcp module) and the client that reads it (`@appstrate/module-chat`).
 */

/** `_meta` key of an agent launch prompt. */
export const AGENT_PROMPT_META_KEY = "dev.appstrate/agent";

/** Payload of {@link AGENT_PROMPT_META_KEY}; `icon`/`color` are `null` when the agent chose none. */
export interface AgentPromptMeta {
  /** `@scope/name`: the seed of the agent's derived colour. */
  packageId: string;
  icon: string | null;
  color: string | null;
}

/** The payload of a prompt's `_meta`, or `null` when it is missing or malformed. */
export function readAgentPromptMeta(
  meta: Record<string, unknown> | undefined,
): AgentPromptMeta | null {
  const payload = meta?.[AGENT_PROMPT_META_KEY];
  if (!payload || typeof payload !== "object") return null;
  const { packageId, icon, color } = payload as Record<string, unknown>;
  if (typeof packageId !== "string" || packageId === "") return null;
  if (icon !== null && typeof icon !== "string") return null;
  if (color !== null && typeof color !== "string") return null;
  return { packageId, icon, color };
}
