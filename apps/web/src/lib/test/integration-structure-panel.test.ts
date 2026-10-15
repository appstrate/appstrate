// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { structurePanelState } from "../integration-structure-panel.ts";

describe("structurePanelState", () => {
  it("asks for the activation before listing connections of an inactive integration", () => {
    expect(structurePanelState("connections:oauth", false, true)).toBe("inactive");
    expect(structurePanelState("connections:oauth", false, false)).toBe("inactive");
  });

  it("asks for the activation before an administrator's settings", () => {
    expect(structurePanelState("auth:oauth", false, true)).toBe("inactive");
    expect(structurePanelState("access", false, true)).toBe("inactive");
  });

  it("shows the package's own reads whatever the activation or the role", () => {
    for (const section of ["files", "tools", "functioning"]) {
      expect(structurePanelState(section, false, false)).toBe("open");
    }
  });

  it("lists connections to any member once active, settings to an administrator only", () => {
    expect(structurePanelState("connections:oauth", true, false)).toBe("open");
    expect(structurePanelState("auth:oauth", true, false)).toBe("admin-only");
    expect(structurePanelState("access", true, true)).toBe("open");
  });
});
