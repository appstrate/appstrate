// SPDX-License-Identifier: Apache-2.0

import { toast } from "sonner";
import i18n from "../i18n";

/**
 * The export's header: the space-approved tools it selects, comma-separated, each element
 * `encodeURIComponent("<integrationId>:<tool>")` so a comma, a colon or a non-ASCII character in
 * a tool name cannot split or merge elements.
 */
export const APPROVED_TOOLS_HEADER = "Appstrate-Space-Approved-Tools";

export interface ApprovedTool {
  /** `@scope/name`; `null` for an element that does not follow the format (shown as received). */
  integrationId: string | null;
  tool: string;
}

// The id is `@scope/name`, free of ":": the tool is what follows the first one after it.
const ELEMENT = /^(@[^/:]+\/[^:]+):([\s\S]+)$/;

function parseElement(element: string): ApprovedTool {
  let decoded = element;
  try {
    decoded = decodeURIComponent(element);
  } catch {
    // Not percent-encoded as promised: shown as received.
  }
  const match = ELEMENT.exec(decoded);
  return match
    ? { integrationId: match[1]!, tool: match[2]! }
    : { integrationId: null, tool: decoded };
}

/** The tools a header names, none for an absent or empty one. */
export function approvedToolsOf(header: string | null | undefined): ApprovedTool[] {
  if (!header) return [];
  return header
    .split(",")
    .map((element) => element.trim())
    .filter(Boolean)
    .map(parseElement);
}

/** « tool, tool (Integration id) » per integration, in the order the header first names them. */
export function describeApprovedTools(tools: readonly ApprovedTool[]): string {
  const byIntegration = new Map<string | null, string[]>();
  for (const { integrationId, tool } of tools) {
    byIntegration.set(integrationId, [...(byIntegration.get(integrationId) ?? []), tool]);
  }
  return [...byIntegration]
    .map(([integrationId, names]) =>
      integrationId ? `${names.join(", ")} (${integrationId})` : names.join(", "),
    )
    .join(" ; ");
}

/** Warns that the importing space must approve the tools this export relies on; silent without any. */
export function warnApprovedTools(header: string | null | undefined): void {
  const tools = approvedToolsOf(header);
  if (tools.length > 0) {
    toast.warning(i18n.t("common:export.approvedTools", { tools: describeApprovedTools(tools) }));
  }
}
