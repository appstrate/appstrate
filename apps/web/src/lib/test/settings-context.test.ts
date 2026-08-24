// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  pickWorkspaceForOrganization,
  settingsContentKey,
  settingsScopeFromPath,
} from "../settings-context";

const workspaces = [
  { id: "ws-first", isDefault: false },
  { id: "ws-default", isDefault: true },
  { id: "ws-last", isDefault: false },
];

describe("settings context", () => {
  it("prefers the last workspace when it still belongs to the organization", () => {
    expect(pickWorkspaceForOrganization(workspaces, "ws-last")?.id).toBe("ws-last");
  });

  it("falls back from an invalid last workspace to default, then first", () => {
    expect(pickWorkspaceForOrganization(workspaces, "ws-elsewhere")?.id).toBe("ws-default");
    expect(
      pickWorkspaceForOrganization(
        workspaces.map((workspace) => ({ ...workspace, isDefault: false })),
        null,
      )?.id,
    ).toBe("ws-first");
  });

  it("keeps the active route scope and remounts only for that scope", () => {
    expect(settingsScopeFromPath("/org-settings/models")).toBe("organization");
    expect(settingsScopeFromPath("/workspace-settings/end-users")).toBe("workspace");
    expect(settingsContentKey("/org-settings/models", "org-a", "ws-a")).toBe("organization:org-a");
    expect(settingsContentKey("/workspace-settings/end-users", "org-a", "ws-a")).toBe(
      "workspace:org-a:ws-a",
    );
    expect(settingsContentKey("/workspace-settings/end-users", "org-a", "ws-b")).toBe(
      "workspace:org-a:ws-b",
    );
  });
});
