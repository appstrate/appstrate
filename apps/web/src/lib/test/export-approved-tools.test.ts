// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, spyOn } from "bun:test";
import { toast } from "sonner";
import { i18nReady } from "../../i18n";
import { warnApprovedTools } from "../export-approved-tools";

await i18nReady;

const element = (integrationId: string, tool: string) =>
  encodeURIComponent(`${integrationId}:${tool}`);

describe("warnApprovedTools", () => {
  it("names each tool the header carries, decoded, trimmed, empty elements dropped", () => {
    const warning = spyOn(toast, "warning").mockImplementation(() => 1);
    warnApprovedTools(
      ` ${element("@acme/notion", "export,all")} , ,${element("@acme/crm", "ns:créer")},%E0%A4%A`,
    );
    expect(warning).toHaveBeenCalledTimes(1);
    const message = String(warning.mock.calls[0]![0]);
    expect(message).toContain("@acme/notion:export,all, @acme/crm:ns:créer, %E0%A4%A");
    expect(message).toContain("approuver");
    warning.mockRestore();
  });

  it("stays silent without the header", () => {
    const warning = spyOn(toast, "warning").mockImplementation(() => 1);
    warnApprovedTools(null);
    warnApprovedTools("");
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });
});
