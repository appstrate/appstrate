import type { JSONSchemaObject } from "@appstrate/shared-types";

/** Copy TOKEN_*, CONFIG_*, INPUT_*, and FLOW_STATE entries from source into target. */
export function filterFlowEnvVars(
  source: Record<string, string>,
  target: Record<string, string>,
): void {
  for (const [k, v] of Object.entries(source)) {
    if (
      k.startsWith("TOKEN_") ||
      k.startsWith("CONFIG_") ||
      k.startsWith("INPUT_") ||
      k === "FLOW_STATE"
    ) {
      target[k] = v;
    }
  }
}

export function buildEnrichedPrompt(
  envVars: Record<string, string>,
  outputSchema?: JSONSchemaObject,
): string {
  const flowPrompt = envVars.FLOW_PROMPT || "";

  const tokenEntries = Object.entries(envVars).filter(([k]) => k.startsWith("TOKEN_"));
  const configEntries = Object.entries(envVars).filter(([k]) => k.startsWith("CONFIG_"));
  const inputEntries = Object.entries(envVars).filter(([k]) => k.startsWith("INPUT_"));

  const sections: string[] = [];

  // API access instructions
  if (tokenEntries.length > 0) {
    sections.push("## API Access\n");
    sections.push(
      "You have OAuth tokens available as environment variables. Use them with curl via Bash.\n",
    );

    for (const [key, _] of tokenEntries) {
      const svcName = key.replace("TOKEN_", "").toLowerCase();
      sections.push(`- **${svcName}**: \`$${key}\``);

      if (svcName === "gmail") {
        sections.push(
          `  Example: \`curl -s -H "Authorization: Bearer $${key}" "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20"\``,
        );
        sections.push(
          `  Get message: \`curl -s -H "Authorization: Bearer $${key}" "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=full"\``,
        );
      } else if (svcName === "clickup") {
        sections.push(
          `  Example: \`curl -s -H "Authorization: Bearer $${key}" "https://api.clickup.com/api/v2/team"\``,
        );
        sections.push(
          `  Create task: \`curl -s -X POST -H "Authorization: Bearer $${key}" -H "Content-Type: application/json" -d '{"name":"...","description":"..."}' "https://api.clickup.com/api/v2/list/{list_id}/task"\``,
        );
      } else if (svcName === "facebook") {
        sections.push(
          `  List Pages: \`curl -s -H "Authorization: Bearer $${key}" "https://graph.facebook.com/v21.0/me/accounts"\``,
        );
        sections.push(
          `  Post to Page: \`curl -s -X POST "https://graph.facebook.com/v21.0/{page_id}/feed" -H "Content-Type: application/json" -d '{"message":"...","access_token":"PAGE_ACCESS_TOKEN"}'\``,
        );
        sections.push(
          `  Note: Use the Page Access Token from /me/accounts (not $${key}) when posting to a Page.`,
        );
      }
    }
    sections.push("");
  }

  // User input for this execution
  if (inputEntries.length > 0) {
    sections.push("## User Input\n");
    for (const [key, value] of inputEntries) {
      const name = key.replace("INPUT_", "").toLowerCase();
      sections.push(`- **${name}**: ${value}`);
    }
    sections.push("");
  }

  // Config
  if (configEntries.length > 0) {
    sections.push("## Configuration\n");
    for (const [key, value] of configEntries) {
      const name = key.replace("CONFIG_", "").toLowerCase();
      sections.push(`- **${name}**: ${value}`);
    }
    sections.push("");
  }

  // State
  if (envVars.FLOW_STATE && envVars.FLOW_STATE !== "{}") {
    sections.push("## Previous State\n");
    sections.push("```json");
    sections.push(envVars.FLOW_STATE);
    sections.push("```\n");
  }

  // Output format
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
      // Build example value based on type
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
    "\nIf you need to update persistent state for the next run, include a `state` object.\n",
  );

  return sections.join("\n") + "\n---\n\n" + flowPrompt;
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
