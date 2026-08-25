// SPDX-License-Identifier: Apache-2.0

export type CreationResource = "agent" | "skill" | "integration" | "mcp-server";
export type CreationAudience = "chat" | "coding-agent";
export type CreationLocale = "en" | "fr";

const CREATION_QUERY_KEY = "create";

const OPERATION_IDS: Record<CreationResource, readonly string[]> = {
  agent: ["createAgent", "updateAgent", "createAgentVersion"],
  skill: ["createSkill", "updateSkill", "createSkillVersion"],
  integration: [
    "createIntegrationPackage",
    "updateIntegrationPackage",
    "createIntegrationPackageVersion",
  ],
  "mcp-server": [],
};

const RESOURCE_NAMES: Record<CreationLocale, Record<CreationResource, string>> = {
  en: {
    agent: "Appstrate agent",
    skill: "Appstrate skill",
    integration: "Appstrate integration",
    "mcp-server": "Appstrate MCP server",
  },
  fr: {
    agent: "agent Appstrate",
    skill: "skill Appstrate",
    integration: "intégration Appstrate",
    "mcp-server": "serveur MCP Appstrate",
  },
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

function frenchPrompt(resource: CreationResource, audience: CreationAudience): string {
  const name = RESOURCE_NAMES.fr[resource];
  const clientContext =
    audience === "coding-agent"
      ? "Tu travailles depuis un coding agent connecté au MCP Appstrate de mon organisation. Si cette connexion n’est pas encore disponible, arrête-toi et demande-moi de la configurer depuis Paramètres de l’organisation > Accès MCP. Ne reconstruis jamais l’URL ni la commande de connexion."
      : "Tu travailles dans le Chat Appstrate, avec le contexte de mon organisation et de mon espace de travail déjà injecté. Utilise les outils MCP Appstrate disponibles dans cette conversation.";

  const workflow =
    resource === "mcp-server"
      ? "Pour ce serveur MCP, appelle d’abord `get_runtime_capabilities`. Fais ensuite un seul `run_and_wait` de type inline pour produire le manifeste et les fichiers exécutables, empaqueter l’archive depuis sa racine et la publier avec le runtime tool `publish_document`. Passe le `document://` retourné à `validate_package_document`. Appelle `import_package_document` uniquement si la validation retourne à la fois `valid: true` et `importable: true`, si l’outil est disponible pour mes permissions, et après mon accord explicite."
      : `Pour cette ressource, les opérations pertinentes sont ${packageWorkflow(resource)}. Vérifie qu’elles sont disponibles pour mes permissions, appelle \`describe_operation\` avant chaque mutation, puis utilise \`invoke_operation\` avec le schéma exact retourné.`;

  return `Je veux créer un nouvel ${name}.

Commence par me poser les questions nécessaires pour préciser son objectif, ses utilisateurs, ses entrées et sorties, ses dépendances et ses contraintes. Propose ensuite un plan et attends ma validation avant toute mutation.

${clientContext}

N’invente aucun nom d’outil, operationId, manifeste ou forme de requête. Utilise \`get_me\` lorsque cet outil existe et que le contexte n’est pas déjà injecté. Utilise l’index d’opérations du serveur, puis \`describe_operation\` et \`invoke_operation\`, plutôt que de deviner l’API.

${workflow}

Crée d’abord un brouillon vérifiable. Ne publie ou n’installe la ressource qu’après ma confirmation explicite. À la fin, donne-moi son identifiant Appstrate et le lien de détail à ouvrir.`;
}

function englishPrompt(resource: CreationResource, audience: CreationAudience): string {
  const name = RESOURCE_NAMES.en[resource];
  const clientContext =
    audience === "coding-agent"
      ? "You are working from a coding agent connected to my organization’s Appstrate MCP. If that connection is not available yet, stop and ask me to configure it from Organization settings > MCP access. Never reconstruct the connection URL or command."
      : "You are working inside Appstrate Chat, where my organization and workspace context is already injected. Use the Appstrate MCP tools available in this conversation.";

  const workflow =
    resource === "mcp-server"
      ? "For this MCP server, call `get_runtime_capabilities` first. Then use one inline `run_and_wait` to produce the manifest and executable files, package the archive from its root, and publish it with the `publish_document` runtime tool. Pass the returned `document://` URI to `validate_package_document`. Call `import_package_document` only when validation returns both `valid: true` and `importable: true`, the tool is available to my permissions, and I have explicitly approved the import."
      : `The relevant operations for this resource are ${packageWorkflow(resource)}. Confirm that they are available to my permissions, call \`describe_operation\` before each mutation, then call \`invoke_operation\` with the exact returned schema.`;

  return `I want to create a new ${name}.

First ask the questions needed to clarify its goal, users, inputs and outputs, dependencies, and constraints. Then propose a plan and wait for my approval before mutating anything.

${clientContext}

Do not invent tool names, operationIds, manifests, or request shapes. Use \`get_me\` when that tool exists and context is not already injected. Use the server’s operation index, then \`describe_operation\` and \`invoke_operation\`, instead of guessing the API.

${workflow}

Create a reviewable draft first. Do not publish or install the resource until I explicitly confirm. At the end, give me its Appstrate identifier and the detail URL to open.`;
}

export function buildCreationPrompt(
  resource: CreationResource,
  audience: CreationAudience,
  locale: CreationLocale,
): string {
  return locale === "fr" ? frenchPrompt(resource, audience) : englishPrompt(resource, audience);
}
