// SPDX-License-Identifier: Apache-2.0

import type { PromptContext } from "./types.ts";
import {
  getCredentialFieldName,
  getDefaultAuthorizedUris,
  type ProviderDefinition,
} from "@appstrate/connect";
import { isFileField } from "@appstrate/core/form";
import { sanitizeStorageKey } from "../file-storage.ts";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function buildEnrichedPrompt(ctx: PromptContext): string {
  const sections: string[] = [];
  const connectedProviders = ctx.providers.filter((p) => ctx.tokens[p.id]);

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
      "Only authenticated requests to connected providers require the sidecar credential proxy " +
      "(`$SIDECAR_URL/proxy`) — see **Authenticated Provider API** below.",
  );
  if (ctx.timeout) {
    sections.push(
      `- **Timeout**: You have ${ctx.timeout} seconds to complete this task. ` +
        "Work efficiently and output your result promptly.",
    );
  }
  sections.push(
    "- **Workspace**: `/workspace` is your working directory. " +
      "Uploaded documents are available at `/workspace/documents/`. " +
      "You may use the filesystem for temporary processing during this run only.\n",
  );

  // Available tools
  if (ctx.availableTools && ctx.availableTools.length > 0) {
    sections.push("### Tools");
    sections.push(
      "You have access to the following tools (in addition to standard coding capabilities):\n",
    );
    for (const tool of ctx.availableTools) {
      const desc = tool.description ? `: ${tool.description}` : "";
      sections.push(`- **${tool.name || tool.id}**${desc}`);
    }
    sections.push("");
  }

  // Tool documentation (from TOOL.md files)
  if (ctx.toolDocs && ctx.toolDocs.length > 0) {
    for (const doc of ctx.toolDocs) {
      sections.push(doc.content);
      sections.push("");
    }
  }

  // Available skills
  if (ctx.availableSkills && ctx.availableSkills.length > 0) {
    sections.push("### Skills");
    sections.push(
      "The following skill references are available in your workspace at `.pi/skills/`:\n",
    );
    for (const skill of ctx.availableSkills) {
      const desc = skill.description ? `: ${skill.description}` : "";
      sections.push(`- **${skill.name || skill.id}**${desc}`);
    }
    sections.push("");
  }

  // --- Authenticated provider API access ---
  if (connectedProviders.length > 0) {
    sections.push("## Authenticated Provider API\n");
    sections.push(
      "The sidecar credential proxy at `$SIDECAR_URL/proxy` injects the user's credentials into requests " +
        "to connected provider APIs. You never see or handle raw tokens.\n",
    );
    sections.push(
      "**Use this proxy ONLY for requests to connected providers listed below.** " +
        "For public endpoints (no authentication required), call them directly with `curl` or `fetch` — " +
        "do not route them through the sidecar.\n",
    );
    sections.push("Required headers:");
    sections.push("- `X-Provider`: the provider ID (see list below)");
    sections.push("- `X-Target`: the target URL (must match the provider's authorized URLs)");
    sections.push("- All other headers and the body are forwarded as-is to the target");
    sections.push(
      "- Use `{{variable}}` placeholders in `X-Target` and headers — they are replaced with real credentials at request time",
    );
    sections.push(
      "- Add `X-Substitute-Body: true` if the request body also contains `{{variable}}` placeholders\n",
    );
    sections.push("Example:");
    sections.push("```bash");
    sections.push(`curl -s "$SIDECAR_URL/proxy" \\`);
    sections.push(`  -H "X-Provider: <provider_id>" \\`);
    sections.push(`  -H "X-Target: https://api.example.com/endpoint" \\`);
    sections.push(`  -H "<HeaderName>: <Prefix>{{credential_field}}"`);
    sections.push("```\n");
    sections.push(
      "The proxy returns the upstream response as-is (status code, body, Content-Type). " +
        "If the response was truncated (>50 KB), the `X-Truncated: true` header is present — " +
        "paginate or narrow your query.\n",
    );

    sections.push("### Connected Providers\n");

    for (const provider of connectedProviders) {
      const displayName = provider.displayName ?? provider.id;
      const authorizedUris = getDefaultAuthorizedUris(provider as ProviderDefinition);
      const allowAllUris = provider.allowAllUris ?? false;

      sections.push(`- **${displayName}** (provider ID: \`${provider.id}\`)`);

      // For providers with credentialSchema, show all credential variables
      if (provider.credentialSchema) {
        const props =
          (provider.credentialSchema.properties as Record<string, { description?: string }>) ?? {};
        const varNames = Object.keys(props);
        const varDescriptions = varNames.map((name) => {
          const desc = props[name]?.description ?? name;
          return `\`{{${name}}}\` — ${desc}`;
        });
        if (varDescriptions.length > 0) {
          sections.push(`  Credentials: ${varDescriptions.join(", ")}`);
        }
      } else {
        // OAuth2 / API key — single credential field with header info
        const fieldName = getCredentialFieldName(provider as ProviderDefinition);
        const headerName = provider.credentialHeaderName ?? "Authorization";
        const headerPrefix = provider.credentialHeaderPrefix ?? "Bearer ";
        sections.push(`  Auth: \`${headerName}: ${headerPrefix}{{${fieldName}}}\``);
      }

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
  const inputProps = ctx.schemas.input?.properties;
  const inputRequired = ctx.schemas.input?.required ?? [];
  const nonFileInputEntries = Object.entries(ctx.input).filter(([key]) => {
    const prop = inputProps?.[key];
    return prop ? !isFileField(prop) : true;
  });

  if (nonFileInputEntries.length > 0 || (inputProps && Object.keys(inputProps).length > 0)) {
    sections.push("## User Input\n");
    if (inputProps) {
      for (const [key, prop] of Object.entries(inputProps)) {
        if (isFileField(prop)) continue;
        const req = inputRequired.includes(key) ? "required" : "optional";
        const value = ctx.input[key];
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
  if (ctx.files && ctx.files.length > 0) {
    sections.push("## Documents\n");
    sections.push(
      "The following documents have been uploaded and are available on the local filesystem:\n",
    );
    for (const file of ctx.files) {
      const safeName = sanitizeStorageKey(file.name);
      sections.push(
        `- **${file.name}** (${file.type || "unknown"}, ${formatFileSize(file.size)}) → \`/workspace/documents/${safeName}\``,
      );
    }
    sections.push("\nRead the documents directly from the filesystem.\n");
  }

  // --- Configuration ---
  const configProps = ctx.schemas.config?.properties;
  const configRequired = ctx.schemas.config?.required ?? [];
  const configEntries = Object.entries(ctx.config);

  if (configEntries.length > 0 || (configProps && Object.keys(configProps).length > 0)) {
    sections.push("## Configuration\n");
    if (configProps) {
      for (const [key, prop] of Object.entries(configProps)) {
        const req = configRequired.includes(key) ? "required" : "optional";
        const value = ctx.config[key];
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
  if (ctx.previousState) {
    sections.push("## Previous State\n");
    sections.push(
      "This agent supports stateful operation across runs. " +
        "Your most recent run left the following state:\n",
    );
    sections.push("```json");
    sections.push(JSON.stringify(ctx.previousState, null, 2));
    sections.push("```\n");
    sections.push(
      "Use this state to resume work, avoid reprocessing data, or build on previous results. " +
        "To update the state for the next run, use the `set_state` tool.\n",
    );
  }

  // --- Memory ---
  if (ctx.memories && ctx.memories.length > 0) {
    sections.push("## Memory\n");
    sections.push(
      "This agent has accumulated the following memories from previous runs. " +
        "These are shared across all users running this agent:\n",
    );
    for (const mem of ctx.memories) {
      const date = mem.createdAt ? ` (${mem.createdAt})` : "";
      sections.push(`- ${mem.content}${date}`);
    }
    sections.push(
      "\nTo add new memories, use the `add_memory` tool. " +
        "Use memories for discoveries, learnings, and insights worth remembering long-term. " +
        "Use `set_state` for structured data needed for the next run.\n",
    );
  }

  // --- Run History API ---
  if (ctx.runApi) {
    sections.push("## Run History\n");
    sections.push(
      "You can access data from previous runs beyond just the latest state. " +
        "This is useful for trend analysis, auditing past runs, or recovering from failures.\n",
    );
    sections.push("```bash");
    sections.push('curl -s "$SIDECAR_URL/execution-history?limit=10&fields=state"');
    sections.push("```\n");
    sections.push("Query parameters:");
    sections.push("- `limit` (1-50, default 10): Number of past runs to return");
    sections.push(
      "- `fields` (comma-separated: `state`, `result`; default: `state`): Which data fields to include\n",
    );
    sections.push("Returns `{ runs: [{ id, status, date, duration, ...selected_fields }] }`\n");
  }

  // Append raw prompt at the end, without any interpolation
  return sections.join("\n") + "\n---\n\n" + ctx.rawPrompt;
}
