// SPDX-License-Identifier: Apache-2.0

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { AppstrateCtxProvider } from "@appstrate/runner-pi";

type EmitFn = (obj: Record<string, unknown>) => void;

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
