// SPDX-License-Identifier: Apache-2.0

/**
 * What a space reviews of a remote integration's tools: the undeclared tools the server lists
 * whose definition no approval covers.
 */

import { asRecord } from "@appstrate/core/safe-json";
import type { paths } from "../api/client";

export type ToolPolicy =
  paths["/api/integrations/{packageId}/tool-policy"]["get"]["responses"]["200"]["content"]["application/json"];

/** One entry of an integration's `tool_catalog`: a tool and what the working space can do with it. */
export type ToolCatalogEntry = NonNullable<
  paths["/api/integrations/{packageId}"]["get"]["responses"]["200"]["content"]["application/json"]["tool_catalog"]
>[number];

/** The slice of a catalog entry the policy reads; a catalog without a verdict leaves the rest out. */
export type CatalogRow = Pick<ToolCatalogEntry, "name"> &
  Partial<Pick<ToolCatalogEntry, "status" | "origin">>;

type ToolDefinition = ToolPolicy["listed"][number]["definition"];

/** What a server says of a tool through its MCP `annotations`; an aid to a decision, not a fact. */
export interface ToolHints {
  readOnly: boolean;
  destructive: boolean;
}

/** Only a literal `true` counts: anything else a server sends in `annotations` is ignored. */
export function toolHints(definition: ToolDefinition): ToolHints {
  const annotations = definition?.annotations;
  const hints = annotations !== null && typeof annotations === "object" ? annotations : {};
  return {
    readOnly: (hints as Record<string, unknown>).readOnlyHint === true,
    destructive: (hints as Record<string, unknown>).destructiveHint === true,
  };
}

/** One tool awaiting a verdict. */
export interface ReviewItem {
  name: string;
  /** `null`: no stored listing carries the tool, so there is no definition to approve yet. */
  fingerprint: string | null;
  /** `null`: not listed, or past the snapshot's size cap and not kept. */
  definition: ToolDefinition;
  description: string | null;
  /** The server's own `annotations` of the tool: hints it declares about itself, never verified. */
  hints: ToolHints;
  /** The definition approved before, when this one replaces it. */
  approved: { fingerprint: string; definition: ToolDefinition } | null;
}

type Approval = ToolPolicy["approvals"][number];

/** The newest approval of each tool: the one the policy shows and a changed definition is compared to. */
export function latestApprovals(approvals: readonly Approval[]): Map<string, Approval> {
  const latest = new Map<string, Approval>();
  for (const approval of approvals) {
    const kept = latest.get(approval.tool_name);
    if (!kept || approval.approved_at > kept.approved_at) latest.set(approval.tool_name, approval);
  }
  return latest;
}

/**
 * The catalog's `pending` tools to review: one per listed definition no approval covers (two
 * connections may list two), and one without a definition for a tool no listing carries.
 */
export function reviewItems(
  catalog: readonly CatalogRow[],
  policy: Pick<ToolPolicy, "listed" | "approvals">,
): ReviewItem[] {
  const pending = catalog.filter((tool) => tool.status === "pending").map((tool) => tool.name);
  const approvedFingerprints = new Set(
    policy.approvals.map((approval) => `${approval.tool_name}\0${approval.fingerprint}`),
  );
  const latest = latestApprovals(policy.approvals);
  const approvedOf = (name: string) => {
    const approval = latest.get(name);
    return approval ? { fingerprint: approval.fingerprint, definition: approval.definition } : null;
  };
  return pending.flatMap((name): ReviewItem[] => {
    const listings = policy.listed.filter((listed) => listed.name === name);
    if (listings.length === 0) {
      return [
        {
          name,
          fingerprint: null,
          definition: null,
          description: null,
          hints: toolHints(null),
          approved: approvedOf(name),
        },
      ];
    }
    return listings
      .filter((listed) => !approvedFingerprints.has(`${name}\0${listed.fingerprint}`))
      .map((listed) => {
        const description = listed.definition?.description;
        return {
          name,
          fingerprint: listed.fingerprint,
          definition: listed.definition,
          description: typeof description === "string" ? description : null,
          hints: toolHints(listed.definition),
          approved: approvedOf(name),
        };
      });
  });
}

/** A tool an agent can call: no verdict (a catalog without one) or `available`. */
export function isUsableToolStatus(status: ToolCatalogEntry["status"] | undefined): boolean {
  return status === undefined || status === "available";
}

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

/**
 * The catalog's tools the integration does not declare yet (listed or approved only), minus those
 * the server no longer lists (`missing`): declaring a tool that is gone would only write a dead entry.
 */
export function declarableTools(catalog: readonly CatalogRow[]): string[] {
  return catalog
    .filter((tool) => tool.origin !== "declared" && tool.status !== "missing")
    .map((tool) => tool.name);
}

/** The manifest with an empty `tools_policy` entry appended per name not declared yet. */
export function declareTools(
  manifest: Record<string, unknown>,
  names: readonly string[],
): Record<string, unknown> {
  const policy = asRecord(manifest.tools_policy);
  const added = names.filter((name) => !Object.prototype.hasOwnProperty.call(policy, name));
  if (added.length === 0) return manifest;
  return {
    ...manifest,
    tools_policy: { ...policy, ...Object.fromEntries(added.map((name) => [name, {}])) },
  };
}
