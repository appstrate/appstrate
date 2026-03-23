import type { PromptContext } from "./types.ts";
import {
  getCredentialFieldName,
  getDefaultAuthorizedUris,
  type ProviderDefinition,
} from "@appstrate/connect";
import { sanitizeStorageKey } from "../file-storage.ts";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function buildEnrichedPrompt(ctx: PromptContext): string {
  const sections: string[] = [];
  const connectedServices = ctx.providers.filter((s) => ctx.tokens[s.id]);

  // --- System identity & environment ---
  sections.push("## System\n");
  sections.push("You are an AI agent running on the Appstrate platform.");
  sections.push("You execute a specific task inside an isolated, ephemeral container.\n");

  sections.push("### Environment");
  sections.push(
    "- **Ephemeral container**: This container is destroyed when your execution ends. " +
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
      "You may use the filesystem for temporary processing during this execution only.\n",
  );

  sections.push("### Persistence");
  sections.push(
    "You have two ways to persist data between executions:\n" +
      "- **State**: Use the `set_state` tool to save a JSON object — overwritten each run. " +
      "Use this for structured data you need to process next time (cursors, timestamps, counters).\n" +
      "- **Memory**: Use the `add_memory` tool to save text memos — accumulated across all runs, shared across all users. " +
      "Use this to capture discoveries, learnings, and insights that should persist long-term.\n" +
      "Everything else — files, variables, computations — is lost when this container stops.\n",
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
  if (connectedServices.length > 0) {
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

    for (const svc of connectedServices) {
      const displayName = svc.displayName ?? svc.id;
      const authorizedUris = getDefaultAuthorizedUris(svc as ProviderDefinition);
      const allowAllUris = svc.allowAllUris ?? false;

      sections.push(`- **${displayName}** (provider ID: \`${svc.id}\`)`);

      // For providers with credentialSchema, show all credential variables
      if (svc.credentialSchema) {
        const props =
          (svc.credentialSchema.properties as Record<string, { description?: string }>) ?? {};
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
        const fieldName = getCredentialFieldName(svc as ProviderDefinition);
        const headerName = svc.credentialHeaderName ?? "Authorization";
        const headerPrefix = svc.credentialHeaderPrefix ?? "Bearer ";
        sections.push(`  Auth: \`${headerName}: ${headerPrefix}{{${fieldName}}}\``);
      }

      if (svc.hasProviderDoc) {
        sections.push(`  API docs: \`.pi/providers/${svc.id}/PROVIDER.md\``);
      } else if (svc.docsUrl) {
        sections.push(`  Documentation: ${svc.docsUrl}`);
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
    return prop?.type !== "file";
  });

  if (nonFileInputEntries.length > 0 || (inputProps && Object.keys(inputProps).length > 0)) {
    sections.push("## User Input\n");
    if (inputProps) {
      for (const [key, prop] of Object.entries(inputProps)) {
        if (prop.type === "file") continue;
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
      "This flow supports stateful execution across runs. " +
        "Your most recent execution left the following state:\n",
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
      "This flow has accumulated the following memories from previous executions. " +
        "These are shared across all users running this flow:\n",
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

  // --- Execution History API ---
  if (ctx.executionApi) {
    sections.push("## Execution History\n");
    sections.push(
      "You can access data from previous executions beyond just the latest state. " +
        "This is useful for trend analysis, auditing past results, or recovering from failures.\n",
    );
    sections.push("```bash");
    sections.push('curl -s "$SIDECAR_URL/execution-history?limit=10&fields=state"');
    sections.push("```\n");
    sections.push("Query parameters:");
    sections.push("- `limit` (1-50, default 10): Number of past executions to return");
    sections.push(
      "- `fields` (comma-separated: `state`, `result`; default: `state`): Which data fields to include\n",
    );
    sections.push(
      "Returns `{ executions: [{ id, status, date, duration, ...selected_fields }] }`\n",
    );
  }

  // --- User communication (only when log tool is enabled) ---
  if (ctx.logsEnabled !== false) {
    sections.push("## User Communication\n");
    sections.push(
      "Use the `log` tool to keep the user informed of your progress. " +
        "Messages appear in real time in the user's interface.\n",
    );
    sections.push(
      "Levels: **info** (progress, milestones), **warn** (non-blocking issues), **error** (failures).\n",
    );
    sections.push(
      "Start with a `log` call to announce what you are about to do — " +
        "the user sees a loading indicator until the first message appears. " +
        "Then log at meaningful milestones. Write naturally, as you would to a colleague.\n",
    );
  }

  // --- Output tools ---
  const outputSchema = ctx.schemas.output;
  const outputMode = ctx.outputMode ?? "data";
  sections.push("## Output\n");
  sections.push(
    "Use the following tools to produce your output. " +
      "Do NOT write a JSON code block — use tool calls instead.\n",
  );

  if (outputMode === "report") {
    sections.push("### report(content)");
    sections.push(
      "Stream narrative content in Markdown format. Each call appends to the report. " +
        "Use headings, lists, bold, and tables to structure your content. " +
        "Set `final: true` on your last call to signal the report is complete.\n",
    );
    sections.push(
      "For short reports, a single `report(..., final=true)` call is fine. " +
        "For longer reports (multiple sections), split by section so the user sees progress, " +
        "and set `final: true` on the last call.\n",
    );
  }

  if (
    outputMode === "data" &&
    outputSchema?.properties &&
    Object.keys(outputSchema.properties).length > 0
  ) {
    sections.push("### structured_output(data)");
    sections.push(
      "Return machine-readable data as a JSON object. Each call is deep-merged into the result. " +
        "Include **only** the fields listed below — do not add extra fields.\n",
    );
    sections.push("Fields:");
    for (const [key, prop] of Object.entries(outputSchema.properties)) {
      const req = outputSchema.required?.includes(key) ? "required" : "optional";
      sections.push(`- **${key}** (${prop.type}, ${req}): ${prop.description || ""}`);
    }
    sections.push("");
  }

  sections.push("### set_state(state)");
  sections.push(
    "Persist a JSON object for the next execution run. Only the last call is kept — " +
      "design the state to be self-contained. " +
      "Use for cursors, timestamps, counters, or any data needed to resume work.\n",
  );

  sections.push("### add_memory(content)");
  sections.push(
    "Save a discovery or learning as a long-term memory (shared across all users, persists indefinitely). " +
      "Use for insights worth remembering across runs.\n",
  );

  // Append raw prompt at the end, without any interpolation
  return sections.join("\n") + "\n---\n\n" + ctx.rawPrompt;
}
