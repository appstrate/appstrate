import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

function emit(obj: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

interface ToolResult {
  content: { type: string; text: string }[];
}

/**
 * Normalize the return value of a tool execute function to the expected
 * `{ content: [{ type: "text", text: "..." }] }` format.
 */
function normalizeToolResult(
  result: unknown,
  extId: string,
  toolName: string,
): ToolResult {
  // Already correct format — fast path
  if (
    result &&
    typeof result === "object" &&
    "content" in result &&
    Array.isArray((result as ToolResult).content)
  ) {
    return result as ToolResult;
  }

  // String → wrap
  if (typeof result === "string") {
    emit({
      type: "progress",
      message: `[extension-wrapper] Extension '${extId}' tool '${toolName}' returned a string instead of { content: [...] }. Auto-wrapped.`,
    });
    return { content: [{ type: "text", text: result }] };
  }

  // null/undefined → empty
  if (result == null) {
    emit({
      type: "progress",
      message: `[extension-wrapper] Extension '${extId}' tool '${toolName}' returned null/undefined. Returning empty result.`,
    });
    return { content: [{ type: "text", text: "" }] };
  }

  // Object without content → JSON stringify
  emit({
    type: "progress",
    message: `[extension-wrapper] Extension '${extId}' tool '${toolName}' returned an object without 'content' array. Auto-wrapped as JSON.`,
  });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

/**
 * Wrap an extension factory to:
 * 1. Fix wrong execute signatures (1 param instead of 3)
 * 2. Catch errors in execute
 * 3. Normalize return values
 */
export function wrapExtensionFactory(
  factory: ExtensionFactory,
  extensionId: string,
): ExtensionFactory {
  return (pi) => {
    // Create a proxy around pi that intercepts registerTool
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
          signal: unknown,
        ) => {
          try {
            let result: unknown;

            // Check arity: if original has only 1 parameter, it likely expects
            // params as the first arg (wrong signature)
            if (originalExecute.length === 1) {
              emit({
                type: "progress",
                message: `[extension-wrapper] Extension '${extensionId}' tool '${toolName}' has execute(args) with 1 parameter. The Pi SDK passes (toolCallId, params, signal). Auto-correcting to pass params as first arg.`,
              });
              result = await originalExecute(params);
            } else {
              result = await originalExecute(toolCallId, params, signal);
            }

            return normalizeToolResult(result, extensionId, toolName);
          } catch (err) {
            const message =
              err instanceof Error ? err.message : String(err);
            emit({
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
