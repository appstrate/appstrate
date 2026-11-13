// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * How an integration's upstream tool reaches the agent, shared by every host that exposes MCP
 * tools to it (the sidecar's McpHost, the CLI's remote integrations): which upstream tools are
 * admitted, and the descriptor the model sees under the exposed `{namespace}__{tool}` name.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  MAX_PARAMETER_DESCRIPTION_BYTES,
  MAX_TOOL_DESCRIPTION_BYTES,
  sanitiseTextField,
} from "./sanitize.ts";

/**
 * Why the upstream tool `name` is not exposed: absent from the agent's selection (`allowlist`,
 * `null` = every tool), or listed in the integration's `hidden_tools` (checked after the
 * selection). Both match the upstream name exactly. `null`: the tool is exposed.
 */
export function toolExclusion(
  name: string,
  allowlist: ReadonlySet<string> | null,
  hidden: ReadonlySet<string> | null,
): "allowlist" | "hidden_tools" | null {
  if (allowlist && !allowlist.has(name)) return "allowlist";
  if (hidden?.has(name)) return "hidden_tools";
  return null;
}

/**
 * The descriptor the model sees under `name` for the sanitised upstream tool `sanitised`. A
 * tool exposed under anything but `{namespace}__{upstream name}` leads its description with the
 * upstream name, so the model can match the tool against the server's own documentation.
 */
export function exposedToolDescriptor(sanitised: Tool, namespace: string, name: string): Tool {
  if (name === `${namespace}__${sanitised.name}`) return { ...sanitised, name };
  const upstreamName = JSON.stringify(
    sanitiseTextField(sanitised.name, MAX_PARAMETER_DESCRIPTION_BYTES),
  );
  return {
    ...sanitised,
    name,
    description: sanitiseTextField(
      `Upstream tool name: ${upstreamName}.${sanitised.description ? `\n\n${sanitised.description}` : ""}`,
      MAX_TOOL_DESCRIPTION_BYTES,
    ),
  };
}
