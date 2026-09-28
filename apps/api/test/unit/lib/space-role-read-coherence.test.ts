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

const RUNS_READS = ["runs:read", "runs:read-all"];

/** Permission → the reads any one of which it requires, canonical first. */
const REQUIREMENTS: [string, string[]][] = [
  // The default: an action needs its resource's read; a read needs nothing.
  ["schedules:write", ["schedules:read"]],
  ["agents:write", ["agents:read"]],
  ["schedules:read", []],
  ["runs:read-all", []],
  // Runs actions and a launch take either runs read, `runs:read` first —
  // a launch is read back as a run, never as the agent.
  ["runs:cancel", RUNS_READS],
  ["runs:delete", RUNS_READS],
  ["agents:run", RUNS_READS],
  // Read-free actions, each next to a gated neighbour on the same resource.
  ["space-members:invite", []],
  ["space-members:change-role", ["space-members:read"]],
  ["integrations:connect", []],
  ["integrations:disconnect", []],
  ["integrations:uninstall", ["integrations:read"]],
  // A resource with no read action, and a string nobody declared.
  ["space-settings:write", []],
  ["credential-proxy:call", []],
  ["nope:write", []],
];

describe("readGrantsFor", () => {
  it.each(REQUIREMENTS)("%s requires one of %p", (permission, reads) => {
    expect(readGrantsFor(permission)).toEqual(reads);
  });
});

describe("missingReadGrants", () => {
  it("is satisfied by any one of the reads, and names them all when none is held", () => {
    expect(missingReadGrants(["runs:cancel"])).toEqual([
      { permission: "runs:cancel", reads: RUNS_READS },
    ]);
    expect(missingReadGrants(["runs:cancel", "runs:read-all"])).toEqual([]);
    expect(missingReadGrants(["runs:delete", "runs:read"])).toEqual([]);
    expect(missingReadGrants(["agents:run", "runs:read"])).toEqual([]);
    expect(missingReadGrants(["schedules:write", "schedules:read"])).toEqual([]);
  });

  it("names every missing read, sorted, and ignores unknown strings", () => {
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
