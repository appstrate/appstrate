// SPDX-License-Identifier: Apache-2.0

import { toast } from "sonner";
import i18n from "../i18n";

/** The export's header: the space-approved tools it selects, as `<integrationId>:<tool>,…`. */
export const APPROVED_TOOLS_HEADER = "Appstrate-Space-Approved-Tools";

/** The tools a header names, none for an absent or empty one. */
export function approvedToolsOf(header: string | null | undefined): string[] {
  return header ? header.split(",").filter(Boolean) : [];
}

/** Warns that the importing space must approve the tools this export relies on; silent without any. */
export function warnApprovedTools(header: string | null | undefined): void {
  const tools = approvedToolsOf(header);
  if (tools.length > 0) {
    toast.warning(i18n.t("common:export.approvedTools", { tools: tools.join(", ") }));
  }
}
