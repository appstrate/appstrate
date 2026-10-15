// SPDX-License-Identifier: Apache-2.0

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
): string {
  return t(CHAT_DRAFT_KEYS[resource]);
}
