// SPDX-License-Identifier: Apache-2.0

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

type EmitFn = (obj: Record<string, unknown>) => void;

/**
 * Capabilities exposed to a tool's `execute` callback as the 4th argument.
 *
 * `providerCall` is the credentialed-call surface for tools, mirroring the
 * LLM-side `provider_call` MCP tool. The credential is injected server-side
 * by the sidecar — the tool never sees the raw key (ADR-003 invariant).
 */
export interface AppstrateToolCtx {
  providerCall: (
    providerId: string,
    args: {
      method?: string;
      target: string;
      headers?: Record<string, string>;
      body?: string | { fromBytes: string; encoding: "base64" };
      responseMode?: { maxInlineBytes?: number; maxTotalBytes?: number };
      substituteBody?: boolean;
    },
  ) => Promise<{
    content: Array<{ type: string; text?: string; resource?: { uri: string } }>;
    isError?: boolean;
    structuredContent?: unknown;
  }>;
}

/** Late-binding accessor: returns `null` until `entrypoint.ts` Phase C wires the MCP client. */
export type AppstrateCtxProvider = () => AppstrateToolCtx | null;

const defaultEmit: EmitFn = () => {};

/**
 * Wrap an extension factory to:
 *   1. Convert thrown errors into MCP error results (so a buggy tool doesn't crash the session).
 *   2. Inject the Appstrate runtime context as the 4th argument when wired.
 *
 * Pi passes 5 args to execute (`toolCallId, params, signal, onUpdate, piCtx`); we forward
 * only the first three plus the optional Appstrate ctx. Tools using the documented
 * 3-arg signature ignore the extra argument — fully back-compatible.
 */
export function wrapExtensionFactory(
  factory: ExtensionFactory,
  extensionId: string,
  emitFn: EmitFn = defaultEmit,
  appstrateCtxProvider?: AppstrateCtxProvider,
): ExtensionFactory {
  return (pi) => {
    const wrappedPi = {
      ...pi,
      registerTool(config: any) {
        const originalExecute = config.execute;
        if (typeof originalExecute !== "function") {
          return pi.registerTool(config);
        }

        const toolName = config.name || "unknown";

        config.execute = async (
          toolCallId: string,
          params: unknown,
          signal: AbortSignal | undefined,
        ) => {
          try {
            const appstrateCtx = appstrateCtxProvider?.() ?? undefined;
            return await originalExecute(toolCallId, params, signal, appstrateCtx);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            emitFn({
              type: "error",
              message: `[extension-wrapper] Extension '${extensionId}' tool '${toolName}': ${message}`,
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error in extension '${extensionId}' tool '${toolName}': ${message}`,
                },
              ],
            };
          }
        };

        return pi.registerTool(config);
      },
    };

    return factory(wrappedPi as typeof pi);
  };
}
