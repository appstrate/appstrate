// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, spyOn } from "bun:test";
import { toast } from "sonner";
import { i18nReady } from "../../i18n";
import {
  approvedToolsOf,
  describeApprovedTools,
  warnApprovedTools,
} from "../export-approved-tools";

await i18nReady;

const element = (integrationId: string, tool: string) =>
  encodeURIComponent(`${integrationId}:${tool}`);

describe("approvedToolsOf", () => {
  it("decodes each element and splits on the first colon after the integration id", () => {
    const header = [
      element("@acme/notion", "search"),
      element("@acme/notion", "export,all"),
      element("@acme/crm", "ns:créer"),
    ].join(",");
    expect(approvedToolsOf(header)).toEqual([
      { integrationId: "@acme/notion", tool: "search" },
      { integrationId: "@acme/notion", tool: "export,all" },
      { integrationId: "@acme/crm", tool: "ns:créer" },
    ]);
  });

  it("trims the elements and ignores empty ones", () => {
    expect(approvedToolsOf(` ${element("@a/b", "x")} , ,`)).toEqual([
      { integrationId: "@a/b", tool: "x" },
    ]);
    expect(approvedToolsOf(null)).toEqual([]);
    expect(approvedToolsOf("")).toEqual([]);
  });

  it("keeps an element that does not follow the format, as received", () => {
    expect(approvedToolsOf("plain,%E0%A4%A")).toEqual([
      { integrationId: null, tool: "plain" },
      { integrationId: null, tool: "%E0%A4%A" },
    ]);
  });
});

describe("describeApprovedTools", () => {
  it("groups the tools by integration, in the order first named", () => {
    expect(
      describeApprovedTools(
        approvedToolsOf(
          [
            element("@acme/notion", "search"),
            element("@acme/crm", "list"),
            element("@acme/notion", "export"),
          ].join(","),
        ),
      ),
    ).toBe("search, export (@acme/notion) ; list (@acme/crm)");
  });
});

describe("warnApprovedTools", () => {
  it("warns with the tools the header names, grouped by integration", () => {
    const warning = spyOn(toast, "warning").mockImplementation(() => 1);
    warnApprovedTools(
      [element("@acme/notion", "search"), element("@acme/notion", "export")].join(","),
    );
    expect(warning).toHaveBeenCalledTimes(1);
    const message = String(warning.mock.calls[0]![0]);
    expect(message).toContain("search, export (@acme/notion)");
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
