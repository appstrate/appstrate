// SPDX-License-Identifier: Apache-2.0

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

type EmitFn = (obj: Record<string, unknown>) => void;

/**
 * Default breadcrumb sink for runtime tool-execution errors. The tool's
 * error content is returned to the LLM via the MCP `content` channel,
 * which is the authoritative surface. Tests inject their own spy to
 * observe breadcrumbs; production defaults to a no-op because the
 * unified protocol does not parse ad-hoc side channels.
 */
const defaultEmit: EmitFn = () => {};

/**
 * Wrap an extension factory to catch errors thrown by tool execute functions.
 *
 * Upload-time validation (`validateToolSource` in @appstrate/core) already
 * rejects tools with wrong execute signatures (1 param instead of 3) and
 * warns about missing `{ content: [...] }` return format. This wrapper
 * only provides runtime safety: if a tool throws, the error is caught and
 * returned as a proper MCP error result instead of crashing the agent session.
 */
export function wrapExtensionFactory(
  factory: ExtensionFactory,
  extensionId: string,
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

        config.execute = async (toolCallId: string, params: unknown, signal: unknown) => {
          try {
            return await originalExecute(toolCallId, params, signal);
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
