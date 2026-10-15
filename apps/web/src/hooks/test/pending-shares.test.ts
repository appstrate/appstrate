// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { catalogueHref } from "../../lib/catalogue-link.ts";
import { pendingSharesEntry } from "../use-pending-offers.ts";

const share = (id: string, type: "agent" | "skill") => ({ pkg: { id, type } });

describe("the catalogue entry's pending shares", () => {
  it("links nowhere of its own with none waiting", () => {
    expect(pendingSharesEntry([])).toEqual({ count: 0, href: null });
  });

  it("opens the one share waiting on its package's sheet", () => {
    expect(pendingSharesEntry([share("@acme/triage", "agent")])).toEqual({
      count: 1,
      href: catalogueHref("agent", { packageId: "@acme/triage" }),
    });
  });

  it("opens the first one's kind when several wait", () => {
    expect(
      pendingSharesEntry([share("@acme/triage", "agent"), share("@acme/notes", "skill")]),
    ).toEqual({ count: 2, href: catalogueHref("agent") });
  });
});
