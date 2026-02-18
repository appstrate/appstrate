import type { JSONSchemaObject } from "@appstrate/shared-types";
import type { PromptContext } from "./types.ts";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Build TOKEN_* env vars from a tokens map.
 * Only these are needed in the container (read by entrypoints for curl).
 */
export function buildContainerTokenEnv(tokens: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [svcId, token] of Object.entries(tokens)) {
    env[`TOKEN_${svcId.toUpperCase().replace(/-/g, "_")}`] = token;
  }
  return env;
}

export function buildEnrichedPrompt(ctx: PromptContext): string {
  const sections: string[] = [];

  // API access instructions — use ctx.services + ctx.tokens
  const connectedServices = ctx.services.filter((s) => ctx.tokens[s.id]);
  if (connectedServices.length > 0) {
    sections.push("## API Access\n");
    sections.push(
      "You have OAuth tokens available as environment variables. Use them with curl via Bash.\n",
    );

    for (const svc of connectedServices) {
      const envKey = `TOKEN_${svc.id.toUpperCase().replace(/-/g, "_")}`;
      sections.push(`- **${svc.id}** (${svc.description}): \`$${envKey}\``);

      if (svc.provider === "gmail" || svc.id === "gmail") {
        sections.push(
          `  Example: \`curl -s -H "Authorization: Bearer $${envKey}" "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20"\``,
        );
        sections.push(
          `  Get message: \`curl -s -H "Authorization: Bearer $${envKey}" "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=full"\``,
        );
      } else if (svc.provider === "clickup" || svc.id === "clickup") {
        sections.push(
          `  Example: \`curl -s -H "Authorization: Bearer $${envKey}" "https://api.clickup.com/api/v2/team"\``,
        );
        sections.push(
          `  Create task: \`curl -s -X POST -H "Authorization: Bearer $${envKey}" -H "Content-Type: application/json" -d '{"name":"...","description":"..."}' "https://api.clickup.com/api/v2/list/{list_id}/task"\``,
        );
      } else if (svc.provider === "facebook" || svc.id === "facebook") {
        sections.push(
          `  List Pages: \`curl -s -H "Authorization: Bearer $${envKey}" "https://graph.facebook.com/v21.0/me/accounts"\``,
        );
        sections.push(
          `  Post to Page: \`curl -s -X POST "https://graph.facebook.com/v21.0/{page_id}/feed" -H "Content-Type: application/json" -d '{"message":"...","access_token":"PAGE_ACCESS_TOKEN"}'\``,
        );
        sections.push(
          `  Note: Use the Page Access Token from /me/accounts (not $${envKey}) when posting to a Page.`,
        );
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
    sections.push("The following documents have been uploaded and are available for download:\n");
    for (const file of ctx.files) {
      sections.push(`- **${file.name}** (${file.type || "unknown"}, ${formatFileSize(file.size)})`);
      sections.push(`  Download: \`curl -sL -o "${file.name}" "${file.url}"\``);
    }
    sections.push("\nDownload each document using curl before processing it.\n");
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

  // Execution History API (on-demand access to historical executions)
  if (ctx.executionApi) {
    sections.push("## Execution History API\n");
    sections.push(
      "You can fetch historical execution data on demand using the platform's internal API.\n",
    );
    sections.push("```bash");
    sections.push('curl -s -H "Authorization: Bearer $EXECUTION_TOKEN" \\');
    sections.push('  "$PLATFORM_API_URL/internal/execution-history?limit=10&fields=state"');
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
  // Look for ```json ... ``` blocks (last one wins)
  const matches = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (matches.length > 0) {
    const lastMatch = matches[matches.length - 1]!;
    try {
      return JSON.parse(lastMatch[1]!.trim());
    } catch {
      return null;
    }
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
