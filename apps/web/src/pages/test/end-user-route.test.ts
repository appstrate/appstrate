// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { endUserHref, endUsersHref } from "../end-user-route";

const location = {
  pathname: "/workspace-settings/end-users",
  search: "?source=crm",
  hash: "#directory",
};

describe("end-user panel URL", () => {
  it("opens a detail without dropping unrelated URL state", () => {
    expect(endUserHref(location, "eu/a b")).toBe(
      "/workspace-settings/end-users?source=crm&user=eu%2Fa+b#directory",
    );
  });

  it("gives the direct Edit action an addressable mode", () => {
    expect(endUserHref(location, "eu_1", true)).toBe(
      "/workspace-settings/end-users?source=crm&user=eu_1&edit=1#directory",
    );
  });

  it("closes only this panel and its edit mode", () => {
    expect(
      endUsersHref({
        ...location,
        search: "?source=crm&user=eu_1&edit=1",
      }),
    ).toBe("/workspace-settings/end-users?source=crm#directory");
  });
});
