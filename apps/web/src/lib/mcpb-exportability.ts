// SPDX-License-Identifier: Apache-2.0

import type { IntegrationManifest } from "@appstrate/core/integration";
import { mcpbFromIntegration, McpbProjectionError } from "@appstrate/core/mcpb";

/** Why an integration has no `.mcpb` form: the refusal `code` and the field-naming detail the server would answer. */
export interface McpbRefusal {
  code: McpbProjectionError["code"];
  message: string;
}

/**
 * `null` when the manifest projects onto an MCPB manifest, else the refusal the export would meet.
 * The projection is pure and the server runs the same one, so the menu can say so before the click.
 */
export function mcpbExportRefusal(manifest: unknown): McpbRefusal | null {
  try {
    mcpbFromIntegration(manifest as IntegrationManifest);
    return null;
  } catch (err) {
    if (err instanceof McpbProjectionError) return { code: err.code, message: err.message };
    throw err;
  }
}
