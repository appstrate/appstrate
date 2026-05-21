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
import {
  apiCallRequestJsonSchema,
  readIntegrationRefs,
  readApiCallIntegrationMeta,
  apiCallToolName,
  type IntegrationApiCallResolver,
  type IntegrationRef,
  type Tool as AfpsTool,
  type ToolContext as AfpsToolContext,
} from "@appstrate/afps-runtime/resolvers";

/**
 * Event emitter for credentialled-call telemetry. Receives
 * `api_call.called` / `api_call.completed` / `api_call.failed` events
 * (named for historical continuity with the legacy provider surface).
 */
export type ProviderEventEmitter = (event: { type: string; [k: string]: unknown }) => void;

// Pull body + responseMode JSON schemas from the canonical AFPS source so
// the LLM-facing schema documents the discriminated body union. Same
// rationale as the legacy provider bridge.
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
  emitProvider: ProviderEventEmitter;
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

  // Keep only refs that resolve to an apiCall integration. Pure MCP-server
  // integrations have no generic call surface and are skipped (their tools
  // flow through the sidecar/runner path on the platform, not the CLI).
  const apiCallRefs: { ref: IntegrationRef; toolName: string }[] = [];
  for (const ref of refs) {
    const meta = readApiCallIntegrationMeta(opts.bundle, ref);
    if (meta) apiCallRefs.push({ ref, toolName: apiCallToolName(meta) });
  }
  if (apiCallRefs.length === 0) return [];

  const tools = await opts.integrationResolver.resolve(
    apiCallRefs.map((r) => r.ref),
    opts.bundle,
  );
  if (tools.length === 0) return [];

  // The resolver yields one tool per apiCall ref in the same order. Pair
  // each AFPS tool with its `{ns}__api_call` name.
  const factories: ExtensionFactory[] = [];
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i]!;
    const integrationId = apiCallRefs[i]?.ref.name ?? tool.name;
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
        opts.emitProvider({
          type: "api_call.called",
          runId: opts.runId,
          providerId: integrationId,
          toolCallId,
          timestamp: startedAt,
        });
        const ctx: AfpsToolContext = {
          runId: opts.runId,
          toolCallId,
          workspace: opts.workspace,
          signal: signal ?? new AbortController().signal,
          emit(event) {
            opts.emitProvider(event as { type: string; [k: string]: unknown });
          },
        };
        try {
          const result = await tool.execute(args, ctx);
          opts.emitProvider({
            type: "api_call.completed",
            runId: opts.runId,
            providerId: integrationId,
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
          opts.emitProvider({
            type: "api_call.failed",
            runId: opts.runId,
            providerId: integrationId,
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
