// SPDX-License-Identifier: Apache-2.0

/**
 * What a space reviews of a remote integration's tools: the undeclared tools the server lists
 * whose definition no approval covers, and the bodies of the writes that settle them.
 */

import type { paths } from "../api/client";

export type ToolPolicy =
  paths["/api/integrations/{packageId}/tool-policy"]["get"]["responses"]["200"]["content"]["application/json"];

type ToolDefinition = ToolPolicy["listed"][number]["definition"];

/** One definition awaiting a verdict. */
export interface ReviewItem {
  name: string;
  fingerprint: string;
  /** `null`: past the snapshot's size cap, not kept. */
  definition: ToolDefinition;
  description: string | null;
  /** The definition approved before, when this one replaces it. */
  approved: { fingerprint: string; definition: ToolDefinition } | null;
}

/**
 * The listed definitions of the catalog's `pending` tools that no approval covers, one per
 * fingerprint (two connections may list two).
 */
export function reviewItems(
  catalog: readonly { name: string; status?: string }[],
  policy: Pick<ToolPolicy, "listed" | "approvals">,
): ReviewItem[] {
  const pending = new Set(catalog.filter((tool) => tool.status === "pending").map((t) => t.name));
  const approvedFingerprints = new Set(
    policy.approvals.map((approval) => `${approval.tool_name}\0${approval.fingerprint}`),
  );
  return policy.listed
    .filter(
      (listed) =>
        pending.has(listed.name) &&
        !approvedFingerprints.has(`${listed.name}\0${listed.fingerprint}`),
    )
    .map((listed) => {
      const approval = policy.approvals.find((a) => a.tool_name === listed.name);
      const description = listed.definition?.description;
      return {
        name: listed.name,
        fingerprint: listed.fingerprint,
        definition: listed.definition,
        description: typeof description === "string" ? description : null,
        approved: approval
          ? { fingerprint: approval.fingerprint, definition: approval.definition }
          : null,
      };
    });
}

export const approvalBody = (item: Pick<ReviewItem, "name" | "fingerprint">) => ({
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
