// SPDX-License-Identifier: Apache-2.0

/** `_meta` key of an agent launch prompt (MCP's `icons` takes URLs; an agent's icon is a token). */
export const AGENT_PROMPT_META_KEY = "dev.appstrate/agent";

/** An integration the agent uses, as the agents index names and draws it. */
export interface AgentPromptIntegration {
  id: string;
  name: string;
  icon: string | null;
}

/** Payload of {@link AGENT_PROMPT_META_KEY}. */
export interface AgentPromptMeta {
  /** `@scope/name`: the seed of the agent's derived colour. */
  packageId: string;
  /** The space the agent is installed in, whose install the integrations describe. */
  spaceId: string;
  icon: string | null;
  color: string | null;
  integrations: AgentPromptIntegration[];
}

/** One entry of the meta's `integrations`, or `null` when malformed (an empty id included). */
export function readAgentPromptIntegration(raw: unknown): AgentPromptIntegration | null {
  if (!raw || typeof raw !== "object") return null;
  const { id, name, icon } = raw as Record<string, unknown>;
  if (typeof id !== "string" || id === "" || typeof name !== "string") return null;
  if (icon !== null && typeof icon !== "string") return null;
  return { id, name, icon };
}

/**
 * The payload of a prompt's `_meta`, or `null` when it is missing or malformed. A malformed
 * integration entry is dropped alone.
 */
export function readAgentPromptMeta(
  meta: Record<string, unknown> | undefined,
): AgentPromptMeta | null {
  const payload = meta?.[AGENT_PROMPT_META_KEY];
  if (!payload || typeof payload !== "object") return null;
  const { packageId, spaceId, icon, color, integrations } = payload as Record<string, unknown>;
  if (typeof packageId !== "string" || packageId === "") return null;
  if (typeof spaceId !== "string" || spaceId === "") return null;
  if (icon !== null && typeof icon !== "string") return null;
  if (color !== null && typeof color !== "string") return null;
  if (!Array.isArray(integrations)) return null;
  return {
    packageId,
    spaceId,
    icon,
    color,
    integrations: integrations.flatMap((entry) => readAgentPromptIntegration(entry) ?? []),
  };
}
