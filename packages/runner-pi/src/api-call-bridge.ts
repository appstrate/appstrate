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
import { Type, type ExtensionAPI, type ExtensionFactory } from "./pi-sdk.ts";
import type { Bundle } from "@appstrate/afps-runtime/bundle";
import type { RuntimeEventEmitter } from "./runtime-tools/mcp-forward.ts";
import { piToolResultOrThrow } from "./pi-tool-result.ts";
import {
  apiCallRequestJsonSchema,
  readIntegrationRefs,
  readApiCallIntegrationMetas,
  readIntegrationManifest,
  type IntegrationApiCallResolver,
  type IntegrationRef,
  type Tool as AfpsTool,
  type ToolContext as AfpsToolContext,
} from "@appstrate/afps-runtime/resolvers";
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import {
  resolveEffectiveToolSelection,
  selectedApiCallConfigs,
  type IntegrationManifest,
} from "@appstrate/core/integration";

// Pull body + responseMode JSON schemas from the canonical AFPS source so
// the LLM-facing schema documents the discriminated body union. Same
// rationale as the sidecar api_call bridge.
const SCHEMA_PROPERTIES =
  (apiCallRequestJsonSchema as { properties?: Record<string, unknown> }).properties ?? {};
const BODY_SCHEMA = SCHEMA_PROPERTIES.body ?? {};
const RESPONSE_MODE_SCHEMA = SCHEMA_PROPERTIES.responseMode ?? {};

export interface BuildApiCallExtensionFactoryOptions {
  bundle: Bundle;
  integrationResolver: IntegrationApiCallResolver;
  runId: string;
  workspace: string;
  emitEvent: RuntimeEventEmitter;
}

/**
 * Resolve every apiCall integration declared in the bundle's manifest and
 * expose each api_call tool the agent SELECTED as a `{ns}__api_call` Pi tool.
 * Returns an empty array when the bundle declares none — safe to splice
 * unconditionally into the factory list.
 */
export async function buildApiCallExtensionFactory(
  opts: BuildApiCallExtensionFactoryOptions,
): Promise<ExtensionFactory[]> {
  const refs = readIntegrationRefs(opts.bundle);
  if (refs.length === 0) return [];
  const root = opts.bundle.packages.get(opts.bundle.root)?.manifest;
  const agentTools = new Map(
    parseManifestIntegrations((root ?? {}) as Record<string, unknown>).map((e) => [e.id, e.tools]),
  );

  // Keep only refs with ≥1 SELECTED apiCall surface. Pure MCP-server
  // integrations have no generic call surface and are skipped (their tools
  // flow through the sidecar/runner path on the platform, not the CLI). An
  // integration may opt several auths into api_call, yielding multiple tools
  // — track the owning integration id and whether it is selected per emitted
  // tool so the index pairing below stays aligned with the resolver's
  // (ref, auth) iteration order.
  const refsWithApiCall: IntegrationRef[] = [];
  const perTool: { integrationId: string; selected: boolean }[] = [];
  for (const ref of refs) {
    const metas = readApiCallIntegrationMetas(opts.bundle, ref);
    const selected = selectedApiCallToolNames(
      readIntegrationManifest(opts.bundle, ref),
      agentTools.get(ref.name),
    );
    if (!metas.some((m) => selected.has(m.toolName))) continue;
    refsWithApiCall.push(ref);
    for (const meta of metas) {
      perTool.push({ integrationId: ref.name, selected: selected.has(meta.toolName) });
    }
  }
  if (refsWithApiCall.length === 0) return [];

  const tools = await opts.integrationResolver.resolve(refsWithApiCall, opts.bundle);
  if (tools.length === 0) return [];

  // The resolver yields tools in the same (ref, auth) order we flattened
  // above — pair each AFPS tool with its owning integration id by index.
  const factories: ExtensionFactory[] = [];
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i]!;
    if (perTool[i]?.selected === false) continue;
    const integrationId = perTool[i]?.integrationId ?? tool.name;
    factories.push(makeApiCallExtension(tool, integrationId, opts));
  }
  return factories;
}

/**
 * The api_call tools the platform grants this integration: those its EFFECTIVE selection (the
 * agent's `tools`, else the integration's `default_tools`) grants, by the rule the spawn
 * resolver applies. Anything else would expose a tool whose integration the run's connection
 * snapshot skipped as inert, which the proxy refuses.
 */
function selectedApiCallToolNames(
  manifest: unknown,
  agentTools: readonly string[] | "*" | undefined,
): ReadonlySet<string> {
  if (!manifest || typeof manifest !== "object") return new Set();
  const integration = manifest as IntegrationManifest;
  const selection = resolveEffectiveToolSelection(agentTools, integration);
  return new Set(selectedApiCallConfigs(integration, selection).map((cfg) => cfg.toolName));
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
        let result: Awaited<ReturnType<AfpsTool["execute"]>>;
        try {
          result = await tool.execute(args, ctx);
          opts.emitEvent({
            type: "api_call.completed",
            runId: opts.runId,
            integrationId,
            toolCallId,
            durationMs: Date.now() - startedAt,
            isError: result.isError === true,
            timestamp: Date.now(),
          });
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
        // Outside the try: a tool-level `isError` result throws here (Pi's
        // failure signal) and is not an `api_call.failed` execution error.
        // Pi's AgentToolResult only supports text + image content; AFPS
        // resource entries are coerced into a text stub.
        return piToolResultOrThrow({
          content: result.content.map((c) =>
            c.type === "text" || c.type === "image"
              ? c
              : ({ type: "text", text: `[resource ${c.uri}]` } as const),
          ),
          isError: result.isError === true,
        });
      },
    });
  };
}
