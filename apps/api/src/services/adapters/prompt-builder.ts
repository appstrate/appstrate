// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate platform system prompt composer.
 *
 * ## Contract
 *
 * This module produces the **platform-proprietary** system prompt that
 * wraps the user's raw AFPS template before the agent container starts.
 * It is NOT part of any AFPS contract: external consumers of
 * `@appstrate/afps-runtime` receive only the output of
 * `renderTemplate(bundle.prompt, buildPromptView(context))` — the canonical
 * per-agent template — and are expected to compose their own platform
 * preamble on top (or none at all for a minimal run).
 *
 * ## Inputs
 *
 * - `context: ExecutionContext` — the AFPS canonical run context
 *   (runId, input, memories, state, history, config). Flows through
 *   {@link buildTemplateView} into the 1.1+ Mustache render.
 * - `plan: AppstrateRunPlan` — platform wiring + resolved resources
 *   (LLM config, timeout, providers, tokens, tools, skills, files,
 *   runApi, proxy). Drives every platform-specific section below.
 *
 * ## Structure
 *
 * The resulting prompt concatenates, in order:
 *   1. `## System` — identity + environment (ephemeral, timeout, workspace)
 *   2. `### Tools` — bundle tool catalogue + TOOL.md docs
 *   3. `### Skills` — bundle skill catalogue
 *   4. `## Connected Providers` — `<provider>_call` tool catalogue
 *   5. `## User Input` + `## Documents` — run-scoped input + files
 *   6. `## Configuration` — per-agent config values
 *   7. `## Previous State` — state from last run (if any)
 *   8. `## Memory` — accumulated memories across runs
 *   9. `## Run History` — sidecar `/run-history` API
 *  10. The template-rendered user prompt (1.1+) or verbatim rawPrompt (1.0).
 *
 * An external consumer reproducing Appstrate-level behaviour must either
 * call {@link buildPlatformSystemPrompt} directly (via Appstrate's
 * published adapter surface) or build an equivalent preamble from
 * equivalent inputs — the spec makes no guarantee about either section
 * order or presence.
 */

import type { AppstrateRunPlan } from "./types.ts";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import { getDefaultAuthorizedUris, type ProviderDefinition } from "@appstrate/connect";
import { isFileField } from "@appstrate/core/form";
import { sanitizeStorageKey } from "../file-storage.ts";
import { renderTemplate } from "@appstrate/afps-runtime/template";
import type { PromptView } from "@appstrate/afps-runtime/bundle";

/**
 * Schema versions at or above this threshold render their rawPrompt
 * through logic-less Mustache against a {@link PromptView}. Older
 * versions (including 1.0) keep the literal-append behaviour for
 * backwards compatibility. See AFPS_EXTENSION_ARCHITECTURE.md §3.2.
 */
const TEMPLATE_RENDER_MIN_VERSION = [1, 1] as const;

function supportsTemplateRendering(schemaVersion: string | undefined): boolean {
  if (!schemaVersion) return false;
  const match = /^(\d+)\.(\d+)/.exec(schemaVersion);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const [minMajor, minMinor] = TEMPLATE_RENDER_MIN_VERSION;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

/**
 * Project an {@link ExecutionContext} into the runtime's canonical
 * {@link PromptView} shape — the same structure any external consumer
 * would receive from `buildPromptView()`. `createdAt` is already epoch ms
 * on ExecutionContext (normalised upstream in env-builder).
 */
function buildTemplateView(context: ExecutionContext): PromptView {
  return {
    runId: context.runId,
    input: (context.input as Record<string, unknown>) ?? {},
    config: context.config ?? {},
    state: context.state ?? null,
    memories: context.memories ?? [],
    history: context.history ?? [],
  };
}

/**
 * Compute the tool name the AFPS `makeProviderTool` factory produces for a
 * given provider package id. Must stay in sync with `slugify()` in
 * `packages/afps-runtime/src/resolvers/provider-tool.ts`: strip the
 * leading `@`, replace every non-word character with `_`, append `_call`.
 */
function providerToolName(providerId: string): string {
  return `${providerId.replace(/^@/, "").replace(/[^a-zA-Z0-9_]/g, "_")}_call`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function buildPlatformSystemPrompt(
  context: ExecutionContext,
  plan: AppstrateRunPlan,
): string {
  const sections: string[] = [];
  const input = (context.input as Record<string, unknown>) ?? {};
  const config = context.config ?? {};
  const connectedProviders = plan.providers.filter((p) => plan.tokens[p.id]);

  // --- System identity & environment ---
  sections.push("## System\n");
  sections.push("You are an AI agent running on the Appstrate platform.");
  sections.push("You execute a specific task inside an isolated, ephemeral container.\n");

  sections.push("### Environment");
  sections.push(
    "- **Ephemeral container**: This container is destroyed when your run ends. " +
      "Any files you create, modifications you make, or data you store on the filesystem will be permanently lost. " +
      "Do NOT rely on the filesystem for persistence.",
  );
  sections.push(
    "- **Network access**: Outbound HTTP/HTTPS is available. " +
      "Use `curl`, `fetch`, or any HTTP client to call public APIs and websites directly. " +
      "Authenticated requests to connected providers go through the `<provider>_call` tools " +
      "listed under **Connected Providers** — credentials are injected server-side.",
  );
  if (plan.timeout) {
    sections.push(
      `- **Timeout**: You have ${plan.timeout} seconds to complete this task. ` +
        "Work efficiently and output your result promptly.",
    );
  }
  sections.push(
    "- **Workspace**: Your current working directory is the agent workspace. " +
      "Uploaded documents are available under `./documents/` (relative to cwd). " +
      "You may use the filesystem for temporary processing during this run only.\n",
  );

  // Available tools
  if (plan.availableTools && plan.availableTools.length > 0) {
    sections.push("### Tools");
    sections.push(
      "You have access to the following tools (in addition to standard coding capabilities):\n",
    );
    for (const tool of plan.availableTools) {
      const desc = tool.description ? `: ${tool.description}` : "";
      sections.push(`- **${tool.name || tool.id}**${desc}`);
    }
    sections.push("");
  }

  // Tool documentation (from TOOL.md files)
  if (plan.toolDocs && plan.toolDocs.length > 0) {
    for (const doc of plan.toolDocs) {
      sections.push(doc.content);
      sections.push("");
    }
  }

  // Available skills
  if (plan.availableSkills && plan.availableSkills.length > 0) {
    sections.push("### Skills");
    sections.push(
      "The following skill references are available in your workspace at `.pi/skills/`:\n",
    );
    for (const skill of plan.availableSkills) {
      const desc = skill.description ? `: ${skill.description}` : "";
      sections.push(`- **${skill.name || skill.id}**${desc}`);
    }
    sections.push("");
  }

  // --- Connected providers ---
  // Each connected provider is exposed as a typed `<slug>_call` tool that
  // the AFPS runtime registered for this run. The tool injects credentials
  // server-side before dispatch, enforces the URL allowlist, and returns
  // the upstream `{ status, headers, body }` as a single JSON string. The
  // agent never sees raw tokens or constructs curl commands.
  if (connectedProviders.length > 0) {
    sections.push("## Connected Providers\n");
    sections.push(
      "Use the tool listed next to each provider to make authenticated calls. " +
        "Pass `method`, `target` (absolute URL — must match the provider's authorized URLs), " +
        "and optional `headers` / `body`. Non-2xx upstream responses are returned with `isError: true` — " +
        "read the body to diagnose rather than retrying blindly. Proxy timeout is 30 s. " +
        "For other public APIs (no auth), call them directly with `curl` / `fetch`.\n",
    );

    for (const provider of connectedProviders) {
      const displayName = provider.displayName ?? provider.id;
      const authorizedUris = getDefaultAuthorizedUris(provider as ProviderDefinition);
      const allowAllUris = provider.allowAllUris ?? false;
      const toolName = providerToolName(provider.id);

      sections.push(`- **${displayName}** (\`${provider.id}\`) → \`${toolName}\``);

      if (provider.hasProviderDoc) {
        sections.push(`  API docs: \`.pi/providers/${provider.id}/PROVIDER.md\``);
      } else if (provider.docsUrl) {
        sections.push(`  Documentation: ${provider.docsUrl}`);
      }

      if (allowAllUris) {
        sections.push(`  Authorized URLs: all public URLs`);
      } else if (authorizedUris && authorizedUris.length > 0) {
        sections.push(`  Authorized URLs: ${authorizedUris.join(", ")}`);
      }
    }
    sections.push("");
  }

  // --- User input ---
  const inputProps = plan.schemas.input?.properties;
  const inputRequired = plan.schemas.input?.required ?? [];
  const nonFileInputEntries = Object.entries(input).filter(([key]) => {
    const prop = inputProps?.[key];
    return prop ? !isFileField(prop) : true;
  });

  if (nonFileInputEntries.length > 0 || (inputProps && Object.keys(inputProps).length > 0)) {
    sections.push("## User Input\n");
    if (inputProps) {
      for (const [key, prop] of Object.entries(inputProps)) {
        if (isFileField(prop)) continue;
        const req = inputRequired.includes(key) ? "required" : "optional";
        const value = input[key];
        const valueStr = value !== undefined ? ` — \`${value}\`` : "";
        sections.push(`- **${key}** (${prop.type}, ${req}): ${prop.description || ""}${valueStr}`);
      }
    } else {
      for (const [key, value] of nonFileInputEntries) {
        sections.push(`- **${key}**: ${value}`);
      }
    }
    sections.push("");
  }

  // --- Uploaded documents ---
  if (plan.files && plan.files.length > 0) {
    sections.push("## Documents\n");
    sections.push(
      "The following documents have been uploaded and are available on the local filesystem:\n",
    );
    for (const file of plan.files) {
      const safeName = sanitizeStorageKey(file.name);
      sections.push(
        `- **${file.name}** (${file.type || "unknown"}, ${formatFileSize(file.size)}) → \`./documents/${safeName}\``,
      );
    }
    sections.push(
      "\nRead the documents directly from the filesystem (paths are relative to cwd).\n",
    );
  }

  // --- Configuration ---
  const configProps = plan.schemas.config?.properties;
  const configRequired = plan.schemas.config?.required ?? [];
  const configEntries = Object.entries(config);

  if (configEntries.length > 0 || (configProps && Object.keys(configProps).length > 0)) {
    sections.push("## Configuration\n");
    if (configProps) {
      for (const [key, prop] of Object.entries(configProps)) {
        const req = configRequired.includes(key) ? "required" : "optional";
        const value = config[key];
        const valueStr = value !== undefined ? ` — \`${value}\`` : "";
        sections.push(`- **${key}** (${prop.type}, ${req}): ${prop.description || ""}${valueStr}`);
      }
    } else {
      for (const [key, value] of configEntries) {
        sections.push(`- **${key}**: ${value}`);
      }
    }
    sections.push("");
  }

  // --- Previous state ---
  if (context.state !== undefined && context.state !== null) {
    sections.push("## Previous State\n");
    sections.push(
      "This agent supports stateful operation across runs. " +
        "Your most recent run left the following state:\n",
    );
    sections.push("```json");
    sections.push(JSON.stringify(context.state, null, 2));
    sections.push("```\n");
    sections.push(
      "Use this state to resume work, avoid reprocessing data, or build on previous results. " +
        "To update the state for the next run, use the `set_state` tool.\n",
    );
  }

  // --- Memory ---
  if (context.memories && context.memories.length > 0) {
    sections.push("## Memory\n");
    sections.push(
      "This agent has accumulated the following memories from previous runs. " +
        "These are shared across all users running this agent:\n",
    );
    for (const mem of context.memories) {
      const date = mem.createdAt ? ` (${new Date(mem.createdAt).toISOString()})` : "";
      sections.push(`- ${mem.content}${date}`);
    }
    sections.push(
      "\nTo add new memories, use the `add_memory` tool. " +
        "Use memories for discoveries, learnings, and insights worth remembering long-term. " +
        "Use `set_state` for structured data needed for the next run.\n",
    );
  }

  // --- Run History API ---
  if (plan.runApi) {
    sections.push("## Run History\n");
    sections.push(
      "You can access data from previous runs beyond just the latest state. " +
        "This is useful for trend analysis, auditing past runs, or recovering from failures.\n",
    );
    sections.push("```bash");
    sections.push('curl -s "$SIDECAR_URL/run-history?limit=10&fields=state"');
    sections.push("```\n");
    sections.push("Query parameters:");
    sections.push("- `limit` (1-50, default 10): Number of past runs to return");
    sections.push(
      "- `fields` (comma-separated: `state`, `result`; default: `state`): Which data fields to include\n",
    );
    sections.push("Returns `{ runs: [{ id, status, date, duration, ...selected_fields }] }`\n");
  }

  // schemaVersion 1.1+: render rawPrompt through logic-less Mustache so
  // templates can reference `{{runId}}`, `{{input.*}}`, `{{#memories}}…`,
  // etc. Legacy 1.0 bundles keep verbatim append — unchanged output.
  const finalRawPrompt = supportsTemplateRendering(plan.schemaVersion)
    ? renderTemplate(plan.rawPrompt, buildTemplateView(context))
    : plan.rawPrompt;

  return sections.join("\n") + "\n---\n\n" + finalRawPrompt;
}

/**
 * @deprecated Use {@link buildPlatformSystemPrompt}. Kept only to
 * minimise churn in existing call sites; will be removed once all
 * consumers migrate.
 */
export const buildEnrichedPrompt = buildPlatformSystemPrompt;
