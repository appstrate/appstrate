// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * How an integration's upstream tool reaches the agent, shared by every host that exposes MCP
 * tools to it (the sidecar's McpHost, the CLI's remote integrations): which upstream tools the
 * agent's selection admits ({@link toolExclusion}), then the descriptor the model sees under the
 * exposed `{namespace}__{tool}` name ({@link exposeTool}).
 */

import { allocateMcpToolName } from "@appstrate/core/naming";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  MAX_PARAMETER_DESCRIPTION_BYTES,
  MAX_TOOL_DESCRIPTION_BYTES,
  sanitiseTextField,
  sanitiseToolDescriptor,
  type ToolDescriptorReduction,
} from "./sanitize.ts";
import type { ToolIntegration } from "@appstrate/core/integration";
import { TOOL_INTEGRATION_META_KEY } from "./tool-meta.ts";

/** Why an upstream tool is not exposed by {@link exposeTool}. */
export type ToolExposureExclusion = "name_collision";

export interface ToolExposureOptions {
  /** Package id of the integration serving the tool (`@scope/name`). */
  integrationId: string;
  namespace: string;
  /** Whether an exposed name is held already. */
  isTaken: (name: string) => boolean;
}

/**
 * The descriptor the model sees for the upstream `tool` the selection admits, with the steps
 * sanitisation took to bring it within the schema budget (`reduced`, empty when none), or why it
 * is not exposed: left without a free name.
 */
export function exposeTool(
  tool: Tool,
  opts: ToolExposureOptions,
): { descriptor: Tool; reduced: ToolDescriptorReduction[] } | { exclusion: ToolExposureExclusion } {
  const { tool: sanitised, reduced } = sanitiseToolDescriptor(tool);
  let name: string;
  try {
    name = allocateMcpToolName(opts.namespace, tool.name, opts.isTaken);
  } catch {
    return { exclusion: "name_collision" };
  }
  return {
    descriptor: withToolIntegration(
      exposedToolDescriptor(sanitised, opts.namespace, name),
      opts.integrationId,
      tool,
    ),
    reduced,
  };
}

/**
 * `descriptor` stamped with the integration tool it exposes. Name and title are untrusted server
 * text bound for the run log, hence sanitised; a name left empty stamps nothing.
 */
export function withToolIntegration(descriptor: Tool, integrationId: string, upstream: Tool): Tool {
  const tool = sanitiseTextField(upstream.name, MAX_PARAMETER_DESCRIPTION_BYTES);
  if (!tool) return descriptor;
  const title = [upstream.title, upstream.annotations?.title]
    .map((candidate) => sanitiseTextField(candidate, MAX_PARAMETER_DESCRIPTION_BYTES))
    .find(Boolean);
  const integration: ToolIntegration = { id: integrationId, tool, ...(title ? { title } : {}) };
  return {
    ...descriptor,
    _meta: { ...descriptor._meta, [TOOL_INTEGRATION_META_KEY]: integration },
  };
}

/**
 * Why the upstream tool `name` is not exposed: absent from the agent's selection (`allowlist`,
 * `null` = every tool), or listed in the integration's `hidden_tools` (checked after the
 * selection) or in `blocked` (the space's blocks, checked last). All match the upstream name
 * exactly. `null`: the tool is exposed.
 */
export function toolExclusion(
  name: string,
  allowlist: ReadonlySet<string> | null,
  hidden: ReadonlySet<string> | null,
  blocked: ReadonlySet<string> | null = null,
): "allowlist" | "hidden_tools" | "blocked_in_space" | null {
  if (allowlist && !allowlist.has(name)) return "allowlist";
  if (hidden?.has(name)) return "hidden_tools";
  if (blocked?.has(name)) return "blocked_in_space";
  return null;
}

/**
 * The descriptor the model sees under `name` for the sanitised upstream tool `sanitised`. A
 * tool exposed under anything but `{namespace}__{upstream name}` leads its description with the
 * upstream name, so the model can match the tool against the server's own documentation.
 */
function exposedToolDescriptor(sanitised: Tool, namespace: string, name: string): Tool {
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
