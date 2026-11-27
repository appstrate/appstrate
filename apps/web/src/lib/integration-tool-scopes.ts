// SPDX-License-Identifier: Apache-2.0

import { isUsableToolStatus } from "../components/agent-editor/tool-selection";
import type { ToolCatalogEntry } from "./integration-tool-policy";

/** A tool as the table shows it: its status (absent for a catalog without a verdict) and its scopes. */
interface ScopedTool {
  status?: ToolCatalogEntry["status"];
  permissions?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Whether an integration has an OAuth auth: the only kind whose connection is made for a set of
 * scopes, so the only one where a tool without a declared permission is a risk.
 */
export function hasOAuthAuth(auths: readonly { type: string }[]): boolean {
  return auths.some((auth) => auth.type === "oauth2");
}

/**
 * Whether a tool an agent can call asks for no scope: its grant is unknown, so a connection made
 * for it may be refused upstream. The one predicate of the counter and of the picker's flag.
 */
export function isToolWithoutPermission(tool: ScopedTool): boolean {
  return (
    isUsableToolStatus(tool.status) &&
    Object.values(tool.permissions ?? {}).every((scopes) => scopes.length === 0)
  );
}
