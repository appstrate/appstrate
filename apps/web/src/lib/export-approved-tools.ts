// SPDX-License-Identifier: Apache-2.0

import { toast } from "sonner";
import i18n from "../i18n";

/**
 * The export's header: the space-approved tools it selects, comma-separated, each element
 * `encodeURIComponent("<integrationId>:<tool>")` so a comma, a colon or a non-ASCII character in
 * a tool name cannot split or merge elements.
 */
export const APPROVED_TOOLS_HEADER = "Appstrate-Space-Approved-Tools";

/** An element not percent-encoded as promised is shown as received. */
function decode(element: string): string {
  try {
    return decodeURIComponent(element.trim());
  } catch {
    return element.trim();
  }
}

/** Warns that the importing space must approve the tools this export relies on; silent without any. */
export function warnApprovedTools(header: string | null | undefined): void {
  const tools = (header ?? "").split(",").map(decode).filter(Boolean);
  if (tools.length > 0) {
    toast.warning(i18n.t("common:export.approvedTools", { tools: tools.join(", ") }));
  }
}
