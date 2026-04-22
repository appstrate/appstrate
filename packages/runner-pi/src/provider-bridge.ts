// SPDX-License-Identifier: Apache-2.0

/**
 * Bridge an AFPS {@link ProviderResolver} to the Pi SDK's extension
 * system so tools produced by the resolver (e.g. `gmail_call`) show up
 * as regular Pi tools to the agent.
 *
 * Used by any caller that assembles a {@link PiRunner} (both the local
 * `appstrate` CLI and the `runtime-pi` container entrypoint). The AFPS
 * contract purposely decouples {@link Runner} from bundle wiring:
 * PiRunner consumes a pre-built list of Pi {@link ExtensionFactory}s,
 * and this helper is how callers produce the slice that corresponds to
 * `dependencies.providers` on the manifest.
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

/**
 * Derive the list of `ProviderRef`s from the bundle's root manifest
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

/**
 * Wrap an AFPS {@link Tool} as a Pi {@link ExtensionFactory}. The Pi SDK
 * tool exposes an identical parameter schema and forwards `execute` to
 * the AFPS tool; we pass a minimal {@link ToolContext} built from the
 * run id + workspace dir. Provider events fired via `ctx.emit` are
 * routed back to the caller's event sink through `emitProvider`.
 */
export function afpsToolToPiExtension(
  tool: AfpsTool,
  runId: string,
  workspace: string,
  emitProvider: ProviderEventEmitter,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters as Record<string, unknown>),
      async execute(toolCallId, params, signal) {
        const ctx: AfpsToolContext = {
          runId,
          toolCallId,
          workspace,
          signal: signal ?? new AbortController().signal,
          emit(event) {
            emitProvider(event as { type: string; [k: string]: unknown });
          },
        };
        const result = await tool.execute(params, ctx);
        // Pi's AgentToolResult only supports text + image content (no
        // `resource` variant). AFPS tools can emit resources in theory;
        // `gmail_call` and friends always emit text so we coerce any
        // resource entry into a text stub rather than dropping it silently.
        const content = result.content.map((c) =>
          c.type === "text" || c.type === "image"
            ? c
            : ({ type: "text", text: `[resource ${c.uri}]` } as const),
        );
        // Pi's AgentToolResult requires a `details` field; AFPS tools
        // never populate one, so we emit `undefined` to satisfy the
        // shape without synthesizing data.
        return { content, details: undefined };
      },
    });
  };
}

/**
 * Resolve every provider declared in the bundle's manifest through the
 * given {@link ProviderResolver} and convert the resulting AFPS tools
 * into Pi extension factories ready for `PiRunner({ extensionFactories })`.
 *
 * Returns an empty array when the bundle declares no providers — safe
 * to splice unconditionally into the factory list.
 */
export async function buildProviderExtensionFactories(opts: {
  bundle: Bundle;
  providerResolver: ProviderResolver;
  runId: string;
  workspace: string;
  emitProvider: ProviderEventEmitter;
}): Promise<ExtensionFactory[]> {
  const refs = readProviderRefs(opts.bundle);
  if (refs.length === 0) return [];
  const afpsTools = await opts.providerResolver.resolve(refs, opts.bundle);
  return afpsTools.map((t) =>
    afpsToolToPiExtension(t, opts.runId, opts.workspace, opts.emitProvider),
  );
}
