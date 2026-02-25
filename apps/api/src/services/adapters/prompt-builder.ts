import type { JSONSchemaObject } from "@appstrate/shared-types";
import type { PromptContext } from "./types.ts";
import {
  getBuiltInProviders,
  getCredentialFieldName,
  getDefaultAuthorizedUris,
  type ProviderDefinition,
} from "@appstrate/connect";
import { sanitizeStorageKey } from "../file-storage.ts";

type ProviderLike = NonNullable<PromptContext["providers"]>[number];

/**
 * Get provider definition for prompt building.
 * Prefers ctx.providers (includes custom DB providers) over built-in registry.
 */
function getProviderDef(
  providerId: string,
  ctx?: PromptContext,
): ProviderLike | ProviderDefinition | null {
  if (ctx?.providers) {
    const found = ctx.providers.find((p) => p.id === providerId);
    if (found) return found;
  }
  return getBuiltInProviders().get(providerId) ?? null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function buildEnrichedPrompt(ctx: PromptContext): string {
  const sections: string[] = [];

  // API access instructions — sidecar proxy with curl
  const connectedServices = ctx.services.filter((s) => ctx.tokens[s.id]);
  if (connectedServices.length > 0) {
    sections.push("## API Access\n");
    sections.push("Make authenticated API requests via the proxy at `$SIDECAR_URL/proxy`.\n");
    sections.push("Headers:");
    sections.push("- `X-Service`: the service ID");
    sections.push("- `X-Target`: the target URL (must match the service's authorized URLs)");
    sections.push("- All other headers and the body are forwarded as-is");
    sections.push(
      "- Use `{{variable}}` placeholders in `X-Target` and headers — they are replaced with real credentials",
    );
    sections.push("- Add `X-Substitute-Body: true` if the body also contains placeholders\n");
    sections.push("Example:");
    sections.push("```bash");
    sections.push(`curl -s "$SIDECAR_URL/proxy" \\`);
    sections.push(`  -H "X-Service: <service_id>" \\`);
    sections.push(`  -H "X-Target: https://api.example.com/endpoint" \\`);
    sections.push(`  -H "<HeaderName>: <Prefix>{{credential_field}}"`);
    sections.push("```\n");
    sections.push("The proxy forwards the upstream response as-is (status code, headers, body).");
    sections.push("Use standard HTTP status codes to detect success or failure.");
    sections.push(
      "If the response exceeded the size limit, the `X-Truncated: true` response header is present.\n",
    );

    sections.push("### Connected Services\n");

    for (const svc of connectedServices) {
      const provider = getProviderDef(svc.provider, ctx);
      const displayName = provider?.displayName ?? svc.id;
      const authorizedUris = provider
        ? getDefaultAuthorizedUris(provider as ProviderDefinition)
        : null;
      const allowAllUris = provider?.allowAllUris ?? false;

      sections.push(`- **${displayName}** (service ID: \`${svc.id}\`)`);

      // For providers with credentialSchema, show all credential variables
      if (provider && provider.credentialSchema) {
        const props = provider.credentialSchema.properties ?? {};
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
        const fieldName = provider
          ? getCredentialFieldName(provider as ProviderDefinition)
          : "token";
        const headerName = provider?.credentialHeaderName ?? "Authorization";
        const headerPrefix = provider?.credentialHeaderPrefix ?? "Bearer ";
        sections.push(`  Auth: \`${headerName}: ${headerPrefix}{{${fieldName}}}\``);
      }

      if (provider?.docsUrl) {
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

  // User input — enriched with schema metadata
  const inputProps = ctx.schemas.input?.properties;
  const inputRequired = ctx.schemas.input?.required ?? [];
  const nonFileInputEntries = Object.entries(ctx.input).filter(([key]) => {
    // Exclude file-type fields (they appear in ## Documents)
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

  // Uploaded documents
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

  // Configuration — enriched with schema metadata
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

  // Previous state (latest execution only)
  if (ctx.previousState) {
    sections.push("## Previous State\n");
    sections.push("State from the most recent execution:\n");
    sections.push("```json");
    sections.push(JSON.stringify(ctx.previousState, null, 2));
    sections.push("```\n");
  }

  // Execution History API (on-demand access to historical executions via sidecar)
  if (ctx.executionApi) {
    sections.push("## Execution History API\n");
    sections.push("You can fetch historical execution data on demand via the sidecar proxy.\n");
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

  // Proxy awareness
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
    const provider = getProviderDef(s.provider, ctx);
    return provider?.categories?.includes("proxy");
  });
  if (proxyServices.length > 0 && !ctx.proxyUrl) {
    sections.push("## Proxy Services\n");
    sections.push(
      "You have access to proxy service(s) for routing requests through residential IPs.",
    );
    sections.push("Use the `X-Proxy` header to route a request through a proxy:\n");
    sections.push("```bash");
    sections.push(`curl -s "$SIDECAR_URL/proxy" \\`);
    sections.push(`  -H "X-Service: ${proxyServices[0]!.id}" \\`);
    sections.push(`  -H "X-Proxy: {{url}}" \\`);
    sections.push(`  -H "X-Target: https://example.com/api/data"`);
    sections.push("```\n");
    sections.push(
      "Use this when a direct request is blocked (403, connection refused) due to IP-based restrictions.\n",
    );
  }

  // Output format
  const outputSchema = ctx.schemas.output;
  sections.push("## Output Format\n");
  sections.push(
    "When you have completed the task, output your final result as a JSON object inside a ```json code block.",
  );

  if (outputSchema?.properties && Object.keys(outputSchema.properties).length > 0) {
    sections.push("\nThe JSON must include the following fields:");
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
    "\nIf you need to persist state for the next run, include a `state` object in your result.\n",
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
