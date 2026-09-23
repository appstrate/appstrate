// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #1513 in the role editor: ticking an action ticks its read, which stays locked —
 * focusable, `aria-disabled`, hinted — while a selected action depends on it alone.
 */

import { describe, it, expect } from "bun:test";
import i18n, { i18nReady } from "../../i18n.ts";
import { render } from "../../test/render.tsx";
import {
  lockedReads,
  togglePermission,
  type RoleVocabularyEntry,
} from "../../lib/role-permission-dependencies.ts";
import { PermissionGroups } from "../org-settings/roles.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

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
const byPermission = new Map(vocabulary.map((e) => [e.permission, e]));
const pick = (permission: string) => byPermission.get(permission)!;

function picker(selected: Set<string>, disabled = false): string {
  return render(
    <PermissionGroups
      groups={[
        { resource: "schedules", permissions: schedules },
        { resource: "runs", permissions: runs },
      ]}
      selected={selected}
      locked={lockedReads(selected, vocabulary)}
      disabled={disabled}
      onToggle={() => {}}
    />,
  );
}

function checkbox(selected: Set<string>, permission: string, disabled = false): string {
  const tag = picker(selected, disabled).match(
    new RegExp(`<button[^>]*id="perm-${permission}"[^>]*>`),
  );
  expect(tag, permission).not.toBeNull();
  return tag![0];
}

function label(selected: Set<string>, permission: string): string {
  const tag = picker(selected).match(new RegExp(`<label[^>]*for="perm-${permission}"[^>]*>`));
  expect(tag, permission).not.toBeNull();
  return tag![0];
}

describe("ticking an action", () => {
  it("also ticks its read", () => {
    expect([...togglePermission(new Set(), pick("schedules:write"))].sort()).toEqual([
      "schedules:read",
      "schedules:write",
    ]);
  });

  it("ticks nothing else for a read-free action", () => {
    expect([...togglePermission(new Set(), connect)]).toEqual(["integrations:connect"]);
  });

  it("adds no read when one it accepts is already held", () => {
    expect([...togglePermission(new Set(["runs:read-all"]), pick("runs:cancel"))].sort()).toEqual([
      "runs:cancel",
      "runs:read-all",
    ]);
  });
});

describe("a read a selected action depends on", () => {
  it("is locked, focusable, and described by a hint naming its dependents", () => {
    const selected = togglePermission(
      togglePermission(new Set(), pick("schedules:write")),
      pick("schedules:delete"),
    );
    const read = checkbox(selected, "schedules:read");
    expect(read).toContain('aria-checked="true"');
    expect(read).toContain('aria-disabled="true"');
    expect(read).not.toContain('disabled=""');
    expect(read).toContain('aria-describedby="perm-schedules:read-required-by"');
    expect(label(selected, "schedules:read")).toContain("text-sm cursor-not-allowed");
    const write = checkbox(selected, "schedules:write");
    expect(write).not.toContain('aria-disabled="true"');
    expect(write).not.toContain("aria-describedby=");
    expect(
      render(
        <PermissionGroups
          groups={[{ resource: "schedules", permissions: schedules }]}
          selected={selected}
          locked={lockedReads(selected, vocabulary)}
          disabled={false}
          onToggle={() => {}}
        />,
      ),
    ).toContain(
      '<span id="perm-schedules:read-required-by" class="text-muted-foreground text-xs">Requis par delete, write.</span>',
    );
  });

  it("names a dependent of another resource in full", () => {
    const selected = togglePermission(new Set(), agentsRun);
    expect([...selected].sort()).toEqual(["agents:run", "runs:read"]);
    expect(picker(selected)).toContain(
      '<span id="perm-runs:read-required-by" class="text-muted-foreground text-xs">Requis par agents:run.</span>',
    );
  });

  it("is truly disabled, like every box, while a save is pending", () => {
    const selected = togglePermission(new Set(), pick("schedules:write"));
    const read = checkbox(selected, "schedules:read", true);
    expect(read).toContain('disabled=""');
    expect(read).not.toContain('aria-disabled="true"');
    expect(checkbox(selected, "schedules:write", true)).toContain('disabled=""');
  });

  it("is enabled again once the action is unticked", () => {
    const ticked = togglePermission(new Set(), pick("schedules:write"));
    const unticked = togglePermission(ticked, pick("schedules:write"));
    expect([...unticked]).toEqual(["schedules:read"]);
    expect(lockedReads(unticked, vocabulary).size).toBe(0);
    expect(checkbox(unticked, "schedules:read")).not.toContain('aria-disabled="true"');
  });

  it("stays free while another read it accepts is held", () => {
    const selected = new Set(["runs:read", "runs:read-all", "runs:cancel"]);
    expect(checkbox(selected, "runs:read")).not.toContain('aria-disabled="true"');
    expect(checkbox(selected, "runs:read-all")).not.toContain('aria-disabled="true"');
    // Unticking `runs:read` leaves `runs:read-all` alone holding the action.
    const withoutRead = new Set(["runs:read-all", "runs:cancel"]);
    expect(checkbox(withoutRead, "runs:read-all")).toContain('aria-disabled="true"');
  });
});
