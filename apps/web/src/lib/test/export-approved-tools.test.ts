// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, spyOn } from "bun:test";
import { toast } from "sonner";
import { i18nReady } from "../../i18n";
import { approvedToolsOf, warnApprovedTools } from "../export-approved-tools";

await i18nReady;

describe("warnApprovedTools", () => {
  it("warns with the tools the header names", () => {
    const warning = spyOn(toast, "warning").mockImplementation(() => 1);
    warnApprovedTools("@acme/notion:search,@acme/notion:export");
    expect(warning).toHaveBeenCalledTimes(1);
    const message = String(warning.mock.calls[0]![0]);
    expect(message).toContain("@acme/notion:search, @acme/notion:export");
    expect(message).toContain("approuver");
    warning.mockRestore();
  });

  it("stays silent without the header", () => {
    const warning = spyOn(toast, "warning").mockImplementation(() => 1);
    warnApprovedTools(null);
    warnApprovedTools("");
    expect(warning).not.toHaveBeenCalled();
    expect(approvedToolsOf(null)).toEqual([]);
    warning.mockRestore();
  });
});
