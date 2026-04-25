// SPDX-License-Identifier: Apache-2.0

/**
 * Build the LLM-facing `provider_call` Pi tool for callers that resolve
 * providers via an AFPS {@link ProviderResolver} (today: the
 * `appstrate` CLI). The tool dispatches by `providerId` to a tool
 * resolved up front via {@link ProviderResolver.resolve} — same shape
 * as the MCP-backed `provider_call` exposed by
 * `runtime-pi/extensions/mcp-direct.ts`, so the LLM-facing surface is
 * identical regardless of whether the run executes inside a container
 * (MCP) or in-process (AFPS resolver).
 *
 * One tool, one schema, regardless of the resolver substrate.
 */
import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { Bundle } from "@appstrate/afps-runtime/bundle";
import type {
  ProviderRef,
  ProviderResolver,
  Tool as AfpsTool,
  ToolContext as AfpsToolContext,
} from "@appstrate/afps-runtime/resolvers";

export type ProviderEventEmitter = (event: { type: string; [k: string]: unknown }) => void;

const PROVIDER_CALL_TOOL_NAME = "provider_call";

/**
 * Derive the list of {@link ProviderRef}s from the bundle's root manifest
 * `dependencies.providers` record. Each key is a scoped package name,
 * each value a semver range — same shape used by the platform.
 */
export function readProviderRefs(bundle: Bundle): ProviderRef[] {
  const root = bundle.packages.get(bundle.root);
  if (!root) return [];
  const manifest = root.manifest as { dependencies?: { providers?: Record<string, string> } };
  const providers = manifest.dependencies?.providers ?? {};
  return Object.entries(providers).map(([name, version]) => ({ name, version }));
}

export interface BuildProviderCallExtensionFactoryOptions {
  bundle: Bundle;
  providerResolver: ProviderResolver;
  runId: string;
  workspace: string;
  emitProvider: ProviderEventEmitter;
}

/**
 * Resolve every provider declared in the bundle's manifest and expose
 * them as a single Pi `provider_call` tool that dispatches by `providerId`.
 *
 * Returns an empty array when the bundle declares no providers — safe
 * to splice unconditionally into the factory list.
 */
export async function buildProviderCallExtensionFactory(
  opts: BuildProviderCallExtensionFactoryOptions,
): Promise<ExtensionFactory[]> {
  const refs = readProviderRefs(opts.bundle);
  if (refs.length === 0) return [];
  const tools = await opts.providerResolver.resolve(refs, opts.bundle);
  if (tools.length === 0) return [];

  // Pair each ref to the AFPS tool the resolver produced for it. The
  // resolver contract guarantees one tool per ref in the same order.
  const byId = new Map<string, AfpsTool>();
  for (let i = 0; i < refs.length && i < tools.length; i++) {
    byId.set(refs[i]!.name, tools[i]!);
  }
  const providerIds = [...byId.keys()];

  return [makeProviderCallExtension(providerIds, byId, opts)];
}

function makeProviderCallExtension(
  providerIds: string[],
  byId: Map<string, AfpsTool>,
  opts: BuildProviderCallExtensionFactoryOptions,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: PROVIDER_CALL_TOOL_NAME,
      label: PROVIDER_CALL_TOOL_NAME,
      description:
        "Make an authenticated request through the credential-injecting proxy. " +
        "Pick the provider via `providerId` (one of the declared providers in this run).",
      parameters: Type.Unsafe<Record<string, unknown>>({
        type: "object",
        additionalProperties: false,
        required: ["providerId", "target"],
        properties: {
          providerId: { type: "string", enum: providerIds },
          target: { type: "string", format: "uri" },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
          },
          headers: { type: "object", additionalProperties: { type: "string" } },
          body: {},
          responseMode: {},
          substituteBody: { type: "boolean" },
        },
      }),
      async execute(toolCallId, params, signal) {
        const args = (params ?? {}) as { providerId?: string } & Record<string, unknown>;
        const providerId = args.providerId;
        if (!providerId || typeof providerId !== "string") {
          return {
            content: [{ type: "text", text: "provider_call: missing or invalid providerId" }],
            details: undefined,
            isError: true,
          };
        }
        const tool = byId.get(providerId);
        if (!tool) {
          return {
            content: [
              {
                type: "text",
                text:
                  `provider_call: unknown providerId "${providerId}". ` +
                  `Available: ${providerIds.join(", ")}`,
              },
            ],
            details: undefined,
            isError: true,
          };
        }
        const startedAt = Date.now();
        opts.emitProvider({
          type: "provider.called",
          runId: opts.runId,
          providerId,
          toolCallId,
          timestamp: startedAt,
        });
        // Strip our dispatcher-only field; forward everything else to
        // the AFPS tool. The AFPS tool params schema does NOT include
        // `providerId` — it is implicit at resolution time.
        const { providerId: _, ...rest } = args;
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
          const result = await tool.execute(rest, ctx);
          opts.emitProvider({
            type: "provider.completed",
            runId: opts.runId,
            providerId,
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
            type: "provider.failed",
            runId: opts.runId,
            providerId,
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
