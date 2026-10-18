// SPDX-License-Identifier: Apache-2.0

/** Companion of `?create=agent`: the integration the new agent starts with. */
export const CREATE_INTEGRATION_PARAM = "integration";

/** `/agents?create=agent&integration=<id>`: the agent creation hand-off, the integration preselected. */
export function agentCreationWithIntegrationPath(integrationId: string): string {
  const params = new URLSearchParams({
    create: "agent",
    [CREATE_INTEGRATION_PARAM]: integrationId,
  });
  return `/agents?${params}`;
}

export type CreationResource = "agent" | "skill" | "integration" | "mcp-server";
export type CreationPromptTranslate = (key: string, values?: Record<string, string>) => string;

const CHAT_DRAFT_KEYS: Record<CreationResource, string> = {
  agent: "creation.chat.draft.agent",
  skill: "creation.chat.draft.skill",
  integration: "creation.chat.draft.integration",
  "mcp-server": "creation.chat.draft.mcpServer",
};

export function chatDraftNavigationState(prompt: string): { composerDraft: string } {
  return { composerDraft: prompt };
}

export function readChatComposerDraft(state: unknown): string | undefined {
  if (!state || typeof state !== "object" || !("composerDraft" in state)) return undefined;
  const draft = (state as { composerDraft?: unknown }).composerDraft;
  return typeof draft === "string" && draft.trim() ? draft : undefined;
}

export function buildChatCreationDraft(
  resource: CreationResource,
  t: CreationPromptTranslate,
  integrationName?: string,
): string {
  const draft = t(CHAT_DRAFT_KEYS[resource]);
  if (resource !== "agent" || !integrationName) return draft;
  return `${draft} ${t("creation.chat.draft.withIntegration", { name: integrationName })}`;
}
