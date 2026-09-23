// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #1513: a space role holds the read each of its actions needs. Custom roles are
 * refused without it and module presets fail boot; the core presets are held to it here.
 */

import { describe, expect, it } from "bun:test";
import { SPACE_ROLE_PRESETS } from "@appstrate/core/permissions";
import {
  missingReadGrants,
  presetPermissions,
  readGrantsFor,
  spaceLevelVocabulary,
} from "../../../src/lib/permissions.ts";

describe("the read requirement of one permission", () => {
  it("is `R:read` for an action, and nothing for the read itself", () => {
    expect(readGrantsFor("schedules:write")).toEqual(["schedules:read"]);
    expect(readGrantsFor("schedules:read")).toEqual([]);
  });

  it("is either runs read for a cancel, `runs:read` first", () => {
    expect(readGrantsFor("runs:cancel")).toEqual(["runs:read", "runs:read-all"]);
    expect(readGrantsFor("runs:read-all")).toEqual([]);
  });

  it("is either runs read for a delete, `runs:read` first", () => {
    expect(readGrantsFor("runs:delete")).toEqual(["runs:read", "runs:read-all"]);
  });

  it("is a runs read for a launch, not the agent's read", () => {
    expect(readGrantsFor("agents:run")).toEqual(["runs:read", "runs:read-all"]);
    expect(readGrantsFor("agents:write")).toEqual(["agents:read"]);
  });

  it("is nothing for a read-free action, and something for its neighbours", () => {
    expect(readGrantsFor("integrations:connect")).toEqual([]);
    expect(readGrantsFor("integrations:disconnect")).toEqual([]);
    expect(readGrantsFor("integrations:uninstall")).toEqual(["integrations:read"]);
    expect(readGrantsFor("space-members:invite")).toEqual([]);
    expect(readGrantsFor("space-members:change-role")).toEqual(["space-members:read"]);
  });

  it("is nothing on a resource with no read action, or for an unknown string", () => {
    expect(readGrantsFor("space-settings:write")).toEqual([]);
    expect(readGrantsFor("credential-proxy:call")).toEqual([]);
    expect(readGrantsFor("nope:write")).toEqual([]);
  });
});

describe("missingReadGrants", () => {
  it("names the read an action lacks, and nothing once it is held", () => {
    expect(missingReadGrants(["schedules:write"])).toEqual([
      { permission: "schedules:write", reads: ["schedules:read"] },
    ]);
    expect(missingReadGrants(["schedules:write", "schedules:read"])).toEqual([]);
  });

  it("accepts `runs:read-all` as the read of a runs action, and names both reads", () => {
    expect(missingReadGrants(["runs:read-all", "runs:cancel"])).toEqual([]);
    expect(missingReadGrants(["runs:cancel"])).toEqual([
      { permission: "runs:cancel", reads: ["runs:read", "runs:read-all"] },
    ]);
  });

  it("refuses a delete with no runs read, and accepts either one", () => {
    expect(missingReadGrants(["runs:delete"])).toEqual([
      { permission: "runs:delete", reads: ["runs:read", "runs:read-all"] },
    ]);
    expect(missingReadGrants(["runs:read", "runs:delete"])).toEqual([]);
    expect(missingReadGrants(["runs:read-all", "runs:delete"])).toEqual([]);
  });

  it("asks a launch for a runs read, either one, and never `agents:read`", () => {
    expect(missingReadGrants(["agents:run"])).toEqual([
      { permission: "agents:run", reads: ["runs:read", "runs:read-all"] },
    ]);
    expect(missingReadGrants(["agents:run", "runs:read"])).toEqual([]);
    expect(missingReadGrants(["agents:run", "runs:read-all"])).toEqual([]);
  });

  it("lets the read-free actions stand alone, and not their neighbours", () => {
    const readFree = ["space-members:invite", "integrations:connect", "integrations:disconnect"];
    expect(missingReadGrants(readFree)).toEqual([]);
    expect(missingReadGrants(["integrations:uninstall"])).toEqual([
      { permission: "integrations:uninstall", reads: ["integrations:read"] },
    ]);
    expect(missingReadGrants(["space-members:change-role"])).toEqual([
      { permission: "space-members:change-role", reads: ["space-members:read"] },
    ]);
    expect(missingReadGrants(["space-settings:write"])).toEqual([]);
  });

  it("ignores unknown strings and sorts what it names", () => {
    expect(missingReadGrants(["retired:thing"])).toEqual([]);
    expect(missingReadGrants(["skills:write", "agents:write", "retired:thing"])).toEqual([
      { permission: "agents:write", reads: ["agents:read"] },
      { permission: "skills:write", reads: ["skills:read"] },
    ]);
  });

  it("holds a module resource to the same rule against the catalog it is given", () => {
    const catalog = new Set(["tasks:read", "tasks:write"]);
    expect(missingReadGrants(["tasks:write"], catalog)).toEqual([
      { permission: "tasks:write", reads: ["tasks:read"] },
    ]);
    expect(missingReadGrants(["tasks:write", "tasks:read"], catalog)).toEqual([]);
  });
});

describe("the vocabulary a role editor reads", () => {
  it("carries each entry's read requirement as `requires_one_of`, empty when none", () => {
    const requires = new Map(
      spaceLevelVocabulary().flatMap((group) =>
        group.permissions.map((entry) => [entry.permission, entry.requires_one_of] as const),
      ),
    );
    expect(requires.get("schedules:write")).toEqual(["schedules:read"]);
    expect(requires.get("runs:cancel")).toEqual(["runs:read", "runs:read-all"]);
    expect(requires.get("agents:run")).toEqual(["runs:read", "runs:read-all"]);
    expect(requires.get("runs:delete")).toEqual(["runs:read", "runs:read-all"]);
    expect(requires.get("runs:read-all")).toEqual([]);
    expect(requires.get("integrations:connect")).toEqual([]);
    expect(requires.get("integrations:disconnect")).toEqual([]);
    expect(requires.get("schedules:read")).toEqual([]);
    expect(requires.get("space-settings:write")).toEqual([]);
  });
});

describe("the presets", () => {
  it("every preset reads what it acts on", () => {
    for (const preset of SPACE_ROLE_PRESETS) {
      expect(missingReadGrants(presetPermissions(preset)), `preset "${preset}"`).toEqual([]);
    }
  });

  it("would not if `runner` gained `agents:write` without `agents:read`", () => {
    // Discriminating twin: the preset check above passes because the rule
    // holds, not because the rule accepts everything.
    const runner = presetPermissions("runner");
    expect(missingReadGrants([...runner, "agents:write"])).toEqual([
      { permission: "agents:write", reads: ["agents:read"] },
    ]);
    const blind = [...runner].filter((permission) => permission !== "runs:read");
    expect(missingReadGrants(blind).map(({ permission }) => permission)).toEqual([
      "agents:run",
      "runs:cancel",
    ]);
  });
});
