// SPDX-License-Identifier: Apache-2.0

import type { operations } from "../api/schema";

export type CreationResource = "agent" | "skill" | "integration" | "mcp-server";
export type CreationAudience = "chat" | "coding-agent";
export type CreationPromptTranslate = (key: string, values?: Record<string, string>) => string;

const CREATION_QUERY_KEY = "create";

type OperationId = keyof operations;

const OPERATION_IDS: Record<Exclude<CreationResource, "mcp-server">, readonly OperationId[]> = {
  agent: ["createAgent", "updateAgent", "createAgentVersion"],
  skill: ["createSkill", "updateSkill", "createSkillVersion"],
  integration: [
    "createIntegrationPackage",
    "updateIntegrationPackage",
    "createIntegrationPackageVersion",
  ],
};

const PROMPT_INTRO_KEYS: Record<CreationResource, string> = {
  agent: "creation.prompt.intro.agent",
  skill: "creation.prompt.intro.skill",
  integration: "creation.prompt.intro.integration",
  "mcp-server": "creation.prompt.intro.mcpServer",
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

function packageWorkflow(resource: Exclude<CreationResource, "mcp-server">): string {
  return OPERATION_IDS[resource].map((operation) => `\`${operation}\``).join(", ");
}

export function buildCreationPrompt(
  resource: CreationResource,
  audience: CreationAudience,
  t: CreationPromptTranslate,
): string {
  const workflow =
    resource === "mcp-server"
      ? t("creation.prompt.mcpWorkflow")
      : t("creation.prompt.packageWorkflow", { operations: packageWorkflow(resource) });

  return [
    t(PROMPT_INTRO_KEYS[resource]),
    t("creation.prompt.questions"),
    t(
      audience === "coding-agent" ? "creation.prompt.codingContext" : "creation.prompt.chatContext",
    ),
    t("creation.prompt.discovery"),
    workflow,
    t("creation.prompt.ending"),
  ].join("\n\n");
}
