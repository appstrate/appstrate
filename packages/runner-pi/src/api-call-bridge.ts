// SPDX-License-Identifier: Apache-2.0

/**
 * Build the LLM-facing `{ns}__api_call` Pi tools for callers that resolve
 * integrations via an AFPS {@link IntegrationApiCallResolver} (today: the
 * `appstrate` CLI). Each apiCall integration becomes ONE Pi tool named
 * `{namespace}__api_call` — matching the platform sidecar's namespacing
 * (`runtime-pi/sidecar/mcp.ts`), so the LLM-facing surface is identical
 * whether the run executes inside a container (MCP) or in-process (AFPS
 * resolver).
 *
 * The unified `api_call` surface exposes one tool per integration — the
 * integration is implied by the tool name, not a parameter.
 */
import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { Bundle } from "@appstrate/afps-runtime/bundle";
import type { RuntimeEventEmitter } from "./runtime-tools/mcp-forward.ts";
import {
  apiCallRequestJsonSchema,
  readIntegrationRefs,
  readApiCallIntegrationMetas,
  type IntegrationApiCallResolver,
  type IntegrationRef,
  type Tool as AfpsTool,
  type ToolContext as AfpsToolContext,
} from "@appstrate/afps-runtime/resolvers";

// Pull body + responseMode JSON schemas from the canonical AFPS source so
// the LLM-facing schema documents the discriminated body union. Same
// rationale as the sidecar api_call bridge.
const SCHEMA_PROPERTIES =
  (apiCallRequestJsonSchema as { properties?: Record<string, unknown> }).properties ?? {};
const BODY_SCHEMA = SCHEMA_PROPERTIES.body ?? {};
const RESPONSE_MODE_SCHEMA = SCHEMA_PROPERTIES.responseMode ?? {};

export { readIntegrationRefs };

export interface BuildApiCallExtensionFactoryOptions {
  bundle: Bundle;
  integrationResolver: IntegrationApiCallResolver;
  runId: string;
  workspace: string;
  emitEvent: RuntimeEventEmitter;
}

/**
 * Resolve every apiCall integration declared in the bundle's manifest and
 * expose each as a `{ns}__api_call` Pi tool. Returns an empty array when
 * the bundle declares no apiCall integrations — safe to splice
 * unconditionally into the factory list.
 */
export async function buildApiCallExtensionFactory(
  opts: BuildApiCallExtensionFactoryOptions,
): Promise<ExtensionFactory[]> {
  const refs = readIntegrationRefs(opts.bundle);
  if (refs.length === 0) return [];

  // Keep only refs that resolve to ≥1 apiCall surface. Pure MCP-server
  // integrations have no generic call surface and are skipped (their tools
  // flow through the sidecar/runner path on the platform, not the CLI). An
  // integration may opt several auths into api_call, yielding multiple tools
  // — track the owning integration id per emitted tool so the index pairing
  // below stays aligned with the resolver's (ref, auth) iteration order.
  const refsWithApiCall: IntegrationRef[] = [];
  const integrationIdPerTool: string[] = [];
  for (const ref of refs) {
    const metas = readApiCallIntegrationMetas(opts.bundle, ref);
    if (metas.length === 0) continue;
    refsWithApiCall.push(ref);
    for (let i = 0; i < metas.length; i++) integrationIdPerTool.push(ref.name);
  }
  if (refsWithApiCall.length === 0) return [];

  const tools = await opts.integrationResolver.resolve(refsWithApiCall, opts.bundle);
  if (tools.length === 0) return [];

  // The resolver yields tools in the same (ref, auth) order we flattened
  // above — pair each AFPS tool with its owning integration id by index.
  const factories: ExtensionFactory[] = [];
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i]!;
    const integrationId = integrationIdPerTool[i] ?? tool.name;
    factories.push(makeApiCallExtension(tool, integrationId, opts));
  }
  return factories;
}

function makeApiCallExtension(
  tool: AfpsTool,
  integrationId: string,
  opts: BuildApiCallExtensionFactoryOptions,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: Type.Unsafe<Record<string, unknown>>({
        type: "object",
        additionalProperties: false,
        required: ["target"],
        properties: {
          target: { type: "string", format: "uri" },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
          },
          headers: { type: "object", additionalProperties: { type: "string" } },
          body: BODY_SCHEMA,
          responseMode: RESPONSE_MODE_SCHEMA,
          substituteBody: { type: "boolean" },
        },
      }),
      async execute(toolCallId, params, signal) {
        const args = (params ?? {}) as Record<string, unknown>;
        const startedAt = Date.now();
        opts.emitEvent({
          type: "api_call.called",
          runId: opts.runId,
          integrationId,
          toolCallId,
          timestamp: startedAt,
        });
        const ctx: AfpsToolContext = {
          runId: opts.runId,
          toolCallId,
          workspace: opts.workspace,
          signal: signal ?? new AbortController().signal,
          emit(event) {
            opts.emitEvent(event as { type: string; [k: string]: unknown });
          },
        };
        try {
          const result = await tool.execute(args, ctx);
          opts.emitEvent({
            type: "api_call.completed",
            runId: opts.runId,
            integrationId,
            toolCallId,
            durationMs: Date.now() - startedAt,
            isError: result.isError === true,
            timestamp: Date.now(),
          });
          // Pi's AgentToolResult only supports text + image content.
          // AFPS resource entries are coerced into a text stub.
          const content = result.content.map((c) =>
            c.type === "text" || c.type === "image"
              ? c
              : ({ type: "text", text: `[resource ${c.uri}]` } as const),
          );
          return { content, details: undefined, isError: result.isError };
        } catch (err) {
          opts.emitEvent({
            type: "api_call.failed",
            runId: opts.runId,
            integrationId,
            toolCallId,
            durationMs: Date.now() - startedAt,
            error: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
          });
          throw err;
        }
      },
    });
  };
}
