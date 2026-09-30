// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #1513 in the role editor: ticking an action ticks its read, which stays held —
 * unticking it is undone, and its note names what needs it — while a selected action
 * depends on it alone. The picker is a closed popover under a static render, so the
 * decisions are pinned here, on the pure functions the editor feeds it.
 */

import { describe, it, expect } from "bun:test";
import {
  dependentsLabel,
  lockedReads,
  withRequiredReads,
  type RoleVocabularyEntry,
} from "../../lib/role-permission-dependencies.ts";

function entry(permission: string, requires_one_of: string[] = []): RoleVocabularyEntry {
  return {
    permission,
    action: permission.slice(permission.indexOf(":") + 1),
    api_key_grantable: true,
    requires_one_of,
  };
}

const schedules = [
  entry("schedules:delete", ["schedules:read"]),
  entry("schedules:read"),
  entry("schedules:write", ["schedules:read"]),
];
const runs = [
  entry("runs:cancel", ["runs:read", "runs:read-all"]),
  entry("runs:read"),
  entry("runs:read-all"),
];
const agentsRun = entry("agents:run", ["runs:read", "runs:read-all"]);
const connect = entry("integrations:connect");
const vocabulary = [...schedules, ...runs, agentsRun, connect];

const complete = (permissions: string[]) =>
  [...withRequiredReads(new Set(permissions), vocabulary)].sort();

describe("ticking an action", () => {
  it("also ticks its read", () => {
    expect(complete(["schedules:write"])).toEqual(["schedules:read", "schedules:write"]);
  });

  it("ticks nothing else for a read-free action", () => {
    expect(complete(["integrations:connect"])).toEqual(["integrations:connect"]);
  });

  it("adds no read when one it accepts is already held", () => {
    expect(complete(["runs:read-all", "runs:cancel"])).toEqual(["runs:cancel", "runs:read-all"]);
  });
});

describe("a read a selected action depends on", () => {
  it("is locked, and its note names its dependents", () => {
    const selected = withRequiredReads(
      new Set(["schedules:write", "schedules:delete"]),
      vocabulary,
    );
    const locked = lockedReads(selected, vocabulary);
    expect([...locked.keys()]).toEqual(["schedules:read"]);
    expect(locked.has("schedules:write")).toBe(false);
    expect(dependentsLabel("schedules:read", locked.get("schedules:read")!)).toBe("delete, write");
  });

  it("cannot be unticked while it is locked", () => {
    // The picker hands back the selection without the read; the editor puts it back.
    expect(complete(["schedules:write"]).includes("schedules:read")).toBe(true);
  });

  it("names a dependent of another resource in full", () => {
    const selected = withRequiredReads(new Set(["agents:run"]), vocabulary);
    expect([...selected].sort()).toEqual(["agents:run", "runs:read"]);
    const locked = lockedReads(selected, vocabulary);
    expect(dependentsLabel("runs:read", locked.get("runs:read")!)).toBe("agents:run");
  });

  it("is free again once the action is unticked", () => {
    const unticked = withRequiredReads(new Set(["schedules:read"]), vocabulary);
    expect([...unticked]).toEqual(["schedules:read"]);
    expect(lockedReads(unticked, vocabulary).size).toBe(0);
    expect(complete([])).toEqual([]);
  });

  it("stays free while another read it accepts is held", () => {
    const both = lockedReads(new Set(["runs:read", "runs:read-all", "runs:cancel"]), vocabulary);
    expect(both.size).toBe(0);
    // Unticking `runs:read` leaves `runs:read-all` alone holding the action.
    const alone = lockedReads(new Set(["runs:read-all", "runs:cancel"]), vocabulary);
    expect([...alone.keys()]).toEqual(["runs:read-all"]);
  });
});
