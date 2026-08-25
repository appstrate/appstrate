// SPDX-License-Identifier: Apache-2.0

export type CreationResource = "agent" | "skill" | "integration" | "mcp-server";
export type CreationPromptTranslate = (key: string, values?: Record<string, string>) => string;

const CREATION_QUERY_KEY = "create";

const CHAT_DRAFT_KEYS: Record<CreationResource, string> = {
  agent: "creation.chat.draft.agent",
  skill: "creation.chat.draft.skill",
  integration: "creation.chat.draft.integration",
  "mcp-server": "creation.chat.draft.mcpServer",
};

export function creationResourceFromSearch(search: string): CreationResource | null {
  const value = new URLSearchParams(search).get(CREATION_QUERY_KEY);
  return value === "agent" || value === "skill" || value === "integration" || value === "mcp-server"
    ? value
    : null;
}

export function creationSearch(search: string, resource: CreationResource | null): string {
  const params = new URLSearchParams(search);
  if (resource) params.set(CREATION_QUERY_KEY, resource);
  else params.delete(CREATION_QUERY_KEY);
  const next = params.toString();
  return next ? `?${next}` : "";
}

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
