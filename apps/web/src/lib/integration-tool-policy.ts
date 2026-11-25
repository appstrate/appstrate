// SPDX-License-Identifier: Apache-2.0

/**
 * What a space reviews of a remote integration's tools: the undeclared tools the server lists
 * whose definition no approval covers, and the bodies of the writes that settle them.
 */

import { asRecord } from "@appstrate/core/safe-json";
import type { paths } from "../api/client";

export type ToolPolicy =
  paths["/api/integrations/{packageId}/tool-policy"]["get"]["responses"]["200"]["content"]["application/json"];

type ToolDefinition = ToolPolicy["listed"][number]["definition"];

/** One tool awaiting a verdict. */
export interface ReviewItem {
  name: string;
  /** `null`: no stored listing carries the tool, so there is no definition to approve yet. */
  fingerprint: string | null;
  /** `null`: not listed, or past the snapshot's size cap and not kept. */
  definition: ToolDefinition;
  description: string | null;
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
  catalog: readonly { name: string; status?: string }[],
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
          approved: approvedOf(name),
        };
      });
  });
}

/** A definition as canonical JSON (keys sorted at every depth): two equal definitions read alike. */
export function canonicalDefinitionJson(definition: unknown): string {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, inner]) => [key, sorted(inner)]),
          )
        : value;
  return JSON.stringify(sorted(definition), null, 2);
}

export const approvalBody = (item: { name: string; fingerprint: string }) => ({
  tools: [{ name: item.name, fingerprint: item.fingerprint }],
});

export const blockBody = (name: string) => ({ tools: [name] });

/** The catalog's tools a space can still block: not blocked yet. */
export function blockableTools(
  catalog: readonly { name: string }[],
  blocks: ToolPolicy["blocks"],
): string[] {
  const blocked = new Set(blocks.map((block) => block.tool_name));
  return catalog.map((tool) => tool.name).filter((name) => !blocked.has(name));
}

/**
 * The catalog's tools the integration does not declare yet (listed or approved only), minus those
 * the server no longer lists (`missing`): declaring a tool that is gone would only write a dead entry.
 */
export function declarableTools(
  catalog: readonly { name: string; origin?: string; status?: string }[],
): string[] {
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
