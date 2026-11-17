// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * The integration tool behind a Pi tool. Pi reports a call by name only, but its session keeps
 * the registered definition object (`getToolDefinition`), so the identity is keyed on it.
 */

import type { ToolIntegration } from "@appstrate/core/integration";
import type { ExtensionAPI } from "./pi-sdk.ts";

type ToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];

const integrations = new WeakMap<object, ToolIntegration>();

/** `pi.registerTool(definition)`, recording the integration tool it exposes, if any. */
export function registerIntegrationTool(
  pi: ExtensionAPI,
  integration: ToolIntegration | undefined,
  definition: ToolDefinition,
): void {
  if (integration !== undefined) integrations.set(definition, integration);
  pi.registerTool(definition);
}

export function integrationOf(definition: object | undefined): ToolIntegration | undefined {
  return definition === undefined ? undefined : integrations.get(definition);
}
