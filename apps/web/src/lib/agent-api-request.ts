// SPDX-License-Identifier: Apache-2.0

import { isFileField, type JSONSchemaObject, type JSONSchema7 } from "@appstrate/core/form";

/** What the agent's API tab needs to write a launch request for it. */
export interface AgentRunRequest {
  packageId: string;
  orgId: string;
  authToken: string;
  inputSchema?: JSONSchemaObject;
  baseUrl: string;
}

/** A placeholder per non-file field: its default, its first enum value, or an empty value of its type. */
function buildInputExample(properties?: Record<string, JSONSchema7>): Record<string, unknown> {
  if (!properties) return {};
  const example: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(properties)) {
    if (isFileField(prop)) continue;
    if (prop.default !== undefined) {
      example[key] = prop.default;
    } else if (prop.enum && prop.enum.length > 0) {
      example[key] = prop.enum[0];
    } else if (prop.type === "number" || prop.type === "integer") {
      example[key] = 0;
    } else if (prop.type === "boolean") {
      example[key] = false;
    } else {
      example[key] = "";
    }
  }
  return example;
}

function requestHead({ packageId, orgId, authToken, baseUrl }: AgentRunRequest): string[] {
  return [
    `curl -X POST "${baseUrl}/api/agents/${packageId}/run" \\`,
    `  -H "Authorization: Bearer ${authToken}" \\`,
    `  -H "X-Org-Id: ${orgId}" \\`,
  ];
}

/** The launch as a JSON body (`POST /api/agents/{scope}/{name}/run`). */
export function buildCurlJson(request: AgentRunRequest): string {
  const input = buildInputExample(request.inputSchema?.properties);
  const body = Object.keys(input).length > 0 ? JSON.stringify({ input }, null, 2) : "{}";
  return [
    ...requestHead(request),
    `  -H "Content-Type: application/json" \\`,
    `  -d '${body}'`,
  ].join("\n");
}

/** The launch as `multipart/form-data`: the input as one JSON part, one part per file field. */
export function buildCurlMultipart(request: AgentRunRequest): string {
  const properties = request.inputSchema?.properties ?? {};
  const input = buildInputExample(properties);
  const lines = requestHead(request);
  if (Object.keys(input).length > 0) lines.push(`  -F 'input=${JSON.stringify(input)}' \\`);
  for (const [key, prop] of Object.entries(properties)) {
    if (isFileField(prop)) lines.push(`  -F '${key}=@/path/to/${key}.pdf' \\`);
  }
  const last = lines.length - 1;
  lines[last] = lines[last]!.replace(/ \\$/, "");
  return lines.join("\n");
}
