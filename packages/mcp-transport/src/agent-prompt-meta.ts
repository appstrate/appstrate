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
  icon: string | null;
  color: string | null;
  integrations: AgentPromptIntegration[];
}

function readIntegration(raw: unknown): AgentPromptIntegration | null {
  if (!raw || typeof raw !== "object") return null;
  const { id, name, icon } = raw as Record<string, unknown>;
  if (typeof id !== "string" || id === "" || typeof name !== "string") return null;
  if (icon !== null && typeof icon !== "string") return null;
  return { id, name, icon };
}

/** The payload of a prompt's `_meta`, or `null` when it is missing or malformed. */
export function readAgentPromptMeta(
  meta: Record<string, unknown> | undefined,
): AgentPromptMeta | null {
  const payload = meta?.[AGENT_PROMPT_META_KEY];
  if (!payload || typeof payload !== "object") return null;
  const { packageId, icon, color, integrations } = payload as Record<string, unknown>;
  if (typeof packageId !== "string" || packageId === "") return null;
  if (icon !== null && typeof icon !== "string") return null;
  if (color !== null && typeof color !== "string") return null;
  if (!Array.isArray(integrations)) return null;
  const read = integrations.map(readIntegration);
  if (read.some((integration) => integration === null)) return null;
  return { packageId, icon, color, integrations: read as AgentPromptIntegration[] };
}
