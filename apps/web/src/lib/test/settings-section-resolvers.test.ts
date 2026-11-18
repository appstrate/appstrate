// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { resolveAgentSettingsSection } from "../agent-settings-sections.ts";
import { resolveIntegrationSettingsSection } from "../integration-settings-sections.ts";

const agent = (
  granted: string[],
  extra: Partial<{ isSystem: boolean; canEditDefinition: boolean }> = {},
) => ({
  grants: (permission: string) => granted.includes(permission),
  readsSchedules: false,
  canEditDefinition: false,
  isSystem: false,
  ...extra,
});

describe("the section an agent's settings open", () => {
  it("is the model for a reader who configures it, else the first section they open", () => {
    expect(resolveAgentSettingsSection(null, agent(["agents:configure", "agents:read"]))).toBe(
      "model",
    );
    expect(resolveAgentSettingsSection(null, agent(["agents:read"]))).toBe("files");
    expect(resolveAgentSettingsSection(null, agent([], { canEditDefinition: true }))).toBe(
      "general",
    );
    // Nothing opened: the first section, its panel explains.
    expect(resolveAgentSettingsSection(null, agent([]))).toBe("files");
  });

  it("is the one named when it applies, locked or not", () => {
    expect(resolveAgentSettingsSection("proxy", agent([]))).toBe("proxy");
    // A system agent has no versions.
    expect(
      resolveAgentSettingsSection("versions", agent(["agents:configure"], { isSystem: true })),
    ).toBe("model");
  });
});

describe("the section an integration's settings open", () => {
  const grants = { canConfigure: true, isOwned: false, hasDefinition: false };
  it("is the Authentification for a reader who configures it, else the files", () => {
    expect(resolveIntegrationSettingsSection(null, grants)).toBe("authentication");
    expect(resolveIntegrationSettingsSection(null, { ...grants, canConfigure: false })).toBe(
      "files",
    );
    expect(resolveIntegrationSettingsSection("access", grants)).toBe("access");
  });

  it("opens the versions and the definition only where they exist", () => {
    expect(resolveIntegrationSettingsSection("versions", grants)).toBe("authentication");
    expect(resolveIntegrationSettingsSection("versions", { ...grants, isOwned: true })).toBe(
      "versions",
    );
    expect(resolveIntegrationSettingsSection("source", { ...grants, hasDefinition: true })).toBe(
      "source",
    );
  });
});
