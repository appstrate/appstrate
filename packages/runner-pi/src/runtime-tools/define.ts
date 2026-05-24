// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Identity factory for runtime-injected tool descriptors. Kept as a thin
 * helper so the `tool.ts` files read uniformly and gain a typed surface.
 *
 * Usage:
 *
 *   export const myTool = defineTool({
 *     id: "my_tool",
 *     name: "my_tool",
 *     description: "...",
 *     parameters: { type: "object", properties: { ... } },
 *   });
 */

import type { RuntimeInjectedTool } from "./types.ts";

export function defineTool(descriptor: RuntimeInjectedTool): RuntimeInjectedTool {
  return descriptor;
}
