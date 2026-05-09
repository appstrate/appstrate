// SPDX-License-Identifier: Apache-2.0

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { AppstrateCtxProvider } from "@appstrate/runner-pi";
import { getErrorMessage } from "@appstrate/core/errors";

type EmitFn = (obj: Record<string, unknown>) => void;

const defaultEmit: EmitFn = () => {};

/**
 * Wrap an extension factory to:
 *   1. Convert thrown errors into MCP error results (so a buggy tool doesn't crash the session).
 *   2. Inject the Appstrate runtime context as the 4th argument to `execute`.
 */
export function wrapExtensionFactory(
  factory: ExtensionFactory,
  extensionId: string,
  appstrateCtxProvider: AppstrateCtxProvider,
  emitFn: EmitFn = defaultEmit,
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
            return await originalExecute(toolCallId, params, signal, appstrateCtxProvider());
          } catch (err) {
            const message = getErrorMessage(err);
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
