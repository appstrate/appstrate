import type { JSONSchemaObject } from "@appstrate/shared-types";
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
  sections.push("You execute a specific task inside an isolated, ephemeral Docker container.\n");

  sections.push("### Environment");
  sections.push(
    "- **Ephemeral container**: This container is destroyed when your execution ends. " +
      "Any files you create, modifications you make, or data you store on the filesystem will be permanently lost. " +
      "Do NOT rely on the filesystem for persistence.",
  );
  sections.push(
    "- **Network isolation**: You have no direct internet access. " +
      "All external API calls must go through the sidecar proxy at `$SIDECAR_URL/proxy`. " +
      "You cannot reach the host machine or any service outside this container directly.",
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
      "- **State**: A JSON object in your output (`state`) — overwritten each run, scoped to the user. " +
      "Use this for structured data you need to process next time (cursors, timestamps, counters).\n" +
      "- **Memory**: A list of text memos (`memories`) — accumulated across all runs, shared across all users. " +
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

  // --- API access instructions ---
  if (connectedServices.length > 0) {
    sections.push("## API Access\n");
    sections.push(
      "Make authenticated API requests via the sidecar proxy at `$SIDECAR_URL/proxy`.\n",
    );
    sections.push("Headers:");
    sections.push("- `X-Provider`: the provider ID");
    sections.push("- `X-Target`: the target URL (must match the service's authorized URLs)");
    sections.push("- All other headers and the body are forwarded as-is");
    sections.push(
      "- Use `{{variable}}` placeholders in `X-Target` and headers — they are replaced with real credentials at request time",
    );
    sections.push(
      "- Add `X-Substitute-Body: true` if the request body also contains placeholders\n",
    );
    sections.push("Example:");
    sections.push("```bash");
    sections.push(`curl -s "$SIDECAR_URL/proxy" \\`);
    sections.push(`  -H "X-Provider: <provider_id>" \\`);
    sections.push(`  -H "X-Target: https://api.example.com/endpoint" \\`);
    sections.push(`  -H "<HeaderName>: <Prefix>{{credential_field}}"`);
    sections.push("```\n");
    sections.push("The proxy forwards the upstream response as-is (status code, headers, body).");
    sections.push("Use standard HTTP status codes to detect success or failure.");
    sections.push(
      "If the response exceeded the size limit, the `X-Truncated: true` response header is present — " +
        "consider paginating or narrowing your query.\n",
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

      if (svc.docsUrl) {
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
        "To update the state for the next run, include an updated `state` object in your JSON output.\n",
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
      "\nTo add new memories, include a `memories` array of strings in your JSON output. " +
        "Use memories for discoveries, learnings, and insights worth remembering long-term. " +
        "Use `state` for structured data needed for the next run.\n",
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

  // --- Proxy awareness ---
  if (ctx.proxyUrl) {
    sections.push("## Network Proxy\n");
    sections.push("An outbound HTTP proxy is configured for this execution.");
    sections.push(
      "All `curl` and HTTP requests are automatically routed through the proxy via environment variables.",
    );
    sections.push(
      "Sidecar API calls via `$SIDECAR_URL/proxy` are also routed through the proxy.\n",
    );
  }

  // Agent-driven proxy (if a proxy service is connected)
  const proxyServices = connectedServices.filter((s) => {
    return s.categories?.includes("proxy");
  });
  if (proxyServices.length > 0 && !ctx.proxyUrl) {
    sections.push("## Proxy Services\n");
    sections.push(
      "You have access to proxy service(s) for routing requests through residential IPs.",
    );
    sections.push("Use the `X-Proxy` header to route a request through a proxy:\n");
    sections.push("```bash");
    sections.push(`curl -s "$SIDECAR_URL/proxy" \\`);
    sections.push(`  -H "X-Provider: ${proxyServices[0]!.id}" \\`);
    sections.push(`  -H "X-Proxy: {{url}}" \\`);
    sections.push(`  -H "X-Target: https://example.com/api/data"`);
    sections.push("```\n");
    sections.push(
      "Use this when a direct request is blocked (403, connection refused) due to IP-based restrictions.\n",
    );
  }

  // --- Output format ---
  const outputSchema = ctx.schemas.output;
  sections.push("## Output Format\n");
  sections.push(
    "When you have completed the task, output your final result as a JSON object inside a ```json code block. " +
      "This is the ONLY output that will be captured and returned to the user — everything else is logged but not persisted as a result.\n",
  );

  if (outputSchema?.properties && Object.keys(outputSchema.properties).length > 0) {
    sections.push("The JSON must include the following fields:");
    const example: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(outputSchema.properties)) {
      const req = outputSchema.required?.includes(key) ? "required" : "optional";
      sections.push(`- **${key}** (${prop.type}, ${req}): ${prop.description || ""}`);
      if (prop.type === "string") example[key] = "...";
      else if (prop.type === "number") example[key] = 0;
      else if (prop.type === "boolean") example[key] = false;
      else if (prop.type === "array") example[key] = [];
      else if (prop.type === "object") example[key] = {};
    }
    sections.push("\nExample:");
    sections.push("```json");
    sections.push(JSON.stringify(example, null, 2));
    sections.push("```");
  } else {
    sections.push("The JSON must contain at minimum a `summary` field (string).");
    sections.push("Example:");
    sections.push("```json");
    sections.push(
      JSON.stringify(
        {
          summary: "Processed 5 emails, created 3 tickets",
          tickets_created: [],
          state: { last_run: "2025-01-01T00:00:00Z" },
        },
        null,
        2,
      ),
    );
    sections.push("```");
  }

  sections.push(
    "\n### State Persistence\n" +
      "Include a `state` object in your JSON output to persist data for the next run. " +
      "Only the latest state is kept — design it to be self-contained.\n",
  );

  sections.push(
    "### Memory Persistence\n" +
      'Include a `memories` array of strings (e.g. `"memories": ["Learned that X works better than Y"]`) ' +
      "to save discoveries and insights that accumulate over time. " +
      "Memories are shared across all users and persist indefinitely.\n",
  );

  sections.push(
    "### Validation\n" +
      "Your JSON output is validated against the expected schema. " +
      "If it does not match, you may be asked to correct it. " +
      "Make sure all required fields are present and correctly typed.\n",
  );

  // Append raw prompt at the end, without any interpolation
  return sections.join("\n") + "\n---\n\n" + ctx.rawPrompt;
}

export function extractJsonResult(text: string): Record<string, unknown> | null {
  // Strategy 1: ```json ... ``` blocks, case-insensitive (last one wins)
  const jsonFenceMatches = [...text.matchAll(/```json\s*\n([\s\S]*?)```/gi)];
  if (jsonFenceMatches.length > 0) {
    const lastMatch = jsonFenceMatches[jsonFenceMatches.length - 1]!;
    try {
      return JSON.parse(lastMatch[1]!.trim());
    } catch {
      // Fall through to next strategy
    }
  }

  // Strategy 2: bare ``` fences (no language tag) whose content starts with { (last one wins)
  const bareFenceMatches = [...text.matchAll(/```(?!\w)\s*\n([\s\S]*?)```/g)];
  for (let i = bareFenceMatches.length - 1; i >= 0; i--) {
    const content = bareFenceMatches[i]![1]!.trim();
    if (content.startsWith("{")) {
      try {
        return JSON.parse(content);
      } catch {
        continue;
      }
    }
  }

  // Strategy 3: raw JSON object in text — find { and its matching }, try parsing
  let searchFrom = text.length;
  while (searchFrom > 0) {
    const openIdx = text.lastIndexOf("{", searchFrom - 1);
    if (openIdx === -1) break;

    // Find matching closing brace (respects string literals)
    let depth = 0;
    let inStr = false;
    let escaped = false;
    let endIdx = -1;
    for (let i = openIdx; i < text.length; i++) {
      const ch = text[i]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\" && inStr) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }

    if (endIdx !== -1) {
      try {
        const parsed = JSON.parse(text.slice(openIdx, endIdx + 1));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // Try previous occurrence
      }
    }
    searchFrom = openIdx;
  }

  return null;
}

export function buildRetryPrompt(
  badResult: Record<string, unknown>,
  validationErrors: string[],
  outputSchema: JSONSchemaObject,
): string {
  const lines: string[] = [];

  lines.push("# Output Correction Required\n");
  lines.push(
    "Your previous output did not match the required schema. Fix the JSON and return ONLY a corrected ```json block.\n",
  );

  lines.push("## Your Previous Output\n");
  lines.push("```json");
  lines.push(JSON.stringify(badResult, null, 2));
  lines.push("```\n");

  lines.push("## Validation Errors\n");
  for (const err of validationErrors) {
    lines.push(`- ${err}`);
  }
  lines.push("");

  lines.push("## Expected Schema\n");
  for (const [key, prop] of Object.entries(outputSchema.properties)) {
    const req = outputSchema.required?.includes(key) ? "required" : "optional";
    lines.push(`- **${key}** (${prop.type}, ${req}): ${prop.description || ""}`);
  }
  lines.push("");

  lines.push("## Instructions\n");
  lines.push(
    "Return ONLY a single ```json code block with the corrected JSON. Do not include any explanation or commentary.",
  );

  return lines.join("\n");
}
