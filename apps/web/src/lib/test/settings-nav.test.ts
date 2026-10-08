// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { activeSettingsItem } from "../settings-nav.ts";

const tabs = [
  { to: "/org-settings/general", show: true },
  { to: "/org-settings/members", show: false },
  { to: "/preferences/general" },
];

describe("activeSettingsItem", () => {
  it("names the tab of the page being shown, nested URLs included", () => {
    expect(activeSettingsItem(tabs, "/org-settings/general")?.to).toBe("/org-settings/general");
    expect(activeSettingsItem(tabs, "/preferences/general/x")?.to).toBe("/preferences/general");
  });

  it("names no tab on a URL the caller has no tab for", () => {
    // A guest on /org-settings/members: the page is refused and the tab hidden.
    expect(activeSettingsItem(tabs, "/org-settings/members")).toBeUndefined();
    expect(activeSettingsItem(tabs, "/org-settings/unknown")).toBeUndefined();
  });
});
