// SPDX-License-Identifier: Apache-2.0

/**
 * Which principal lab mode pretends to be.
 *
 * The whole point of the RBAC work is that a screen shows LESS to a weaker
 * role, and a gate you cannot see is a gate nobody reviews. So the lab serves
 * the permission sets a real caller would hold, and the panel flips between
 * them without a login.
 *
 * The sets below MIRROR `apps/api/src/lib/permissions.ts`. They are derived
 * from the same catalogs (`ORG_LEVEL_PERMISSIONS` / `SPACE_LEVEL_PERMISSIONS`)
 * and filtered by the same rules, rather than retyped as literals: a new
 * permission joins the catalog and reaches the lab in the same commit. What
 * cannot be shared is the filtering itself — those constants live in the API
 * package, which the browser bundle must not import.
 */
import {
  ORG_LEVEL_PERMISSIONS,
  ORG_ROLES_WITH_FULL_ACCESS,
  SPACE_LEVEL_PERMISSIONS,
} from "@appstrate/core/permissions";

export const LAB_ROLES = ["owner", "admin", "member", "guest"] as const;
export type LabRole = (typeof LAB_ROLES)[number];

/**
 * The space preset is its OWN axis, not a consequence of the org role: a person
 * can own the org and hold `viewer` in one space, or be a plain member and
 * `admin` of another. The panel exposes both because that is where the gating
 * actually shows — most screens read space permissions.
 */
export const LAB_PRESETS = ["admin", "builder", "operator", "runner", "viewer"] as const;
export type LabPreset = (typeof LAB_PRESETS)[number];

const PRESET_KEY = "appstrate-lab-preset";

function getPreset(): LabPreset {
  const stored = read(PRESET_KEY);
  return (LAB_PRESETS as readonly string[]).includes(stored ?? "")
    ? (stored as LabPreset)
    : "admin";
}

export function setPreset(next: LabPreset): void {
  localStorage.setItem(PRESET_KEY, next);
  window.location.reload();
}

const orgAll = [...ORG_LEVEL_PERMISSIONS] as string[];
const spaceAll = [...SPACE_LEVEL_PERMISSIONS] as string[];

// `admin` is owner minus the org's identity — re-slugging is owner-only.
const ORG_ADMIN = orgAll.filter((p) => p !== "org:delete" && p !== "org:update");
const ORG_MEMBER = [
  "org:read",
  "members:read",
  "spaces:read",
  "roles:read",
  "models:read",
  "proxies:read",
  "llm-proxy:call",
];
const ORG_GUEST = ORG_MEMBER.filter((p) => p !== "members:read" && p !== "roles:read");

const ORG_PERMISSIONS: Record<LabRole, string[]> = {
  owner: orgAll,
  admin: ORG_ADMIN,
  member: ORG_MEMBER,
  guest: ORG_GUEST,
};

// Space presets, filtered exactly as the server does.
const BUILDER_EXCLUDED = ["space-settings:", "space-members:", "api-keys:"];
const SPACE_ADMIN = spaceAll;
const SPACE_BUILDER = spaceAll.filter((p) => !BUILDER_EXCLUDED.some((x) => p.startsWith(x)));
const SPACE_OPERATOR = [
  "agents:read",
  "agents:run",
  "skills:read",
  "mcp-servers:read",
  "runs:read",
  "runs:cancel",
  "files:read",
  "schedules:read",
  "persistence:read",
  "integrations:read",
  "integrations:connect",
  "integrations:disconnect",
  "end-users:read",
  "end-users:write",
];
const SPACE_VIEWER = SPACE_OPERATOR.filter((p) => p.endsWith(":read"));

/** `runner`: launch, and see only its own — no reading of what the agent is made of. */
const SPACE_RUNNER = [
  "agents:run",
  "runs:read",
  "runs:cancel",
  "files:read",
  "persistence:read",
  "integrations:read",
  "integrations:connect",
  "integrations:disconnect",
];

const SPACE_PERMISSIONS: Record<LabPreset, string[]> = {
  admin: SPACE_ADMIN,
  builder: SPACE_BUILDER,
  operator: SPACE_OPERATOR,
  runner: SPACE_RUNNER,
  viewer: SPACE_VIEWER,
};

const STORAGE_KEY = "appstrate-lab-role";

/**
 * Reads through a guard because this module is imported by `fixtures.ts`, which
 * the handler TESTS import under Bun — where there is no `localStorage` at all.
 * An unguarded read throws at module-evaluation time and leaves every export of
 * the importing module uninitialised, which surfaces as an unrelated
 * "Cannot access 'ROUTES' before initialization".
 */
function read(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function getRole(): LabRole {
  const stored = read(STORAGE_KEY);
  return (LAB_ROLES as readonly string[]).includes(stored ?? "") ? (stored as LabRole) : "owner";
}

/** Full reload, like the scenario switcher: it clears the query cache in one step. */
export function setRole(next: LabRole): void {
  localStorage.setItem(STORAGE_KEY, next);
  window.location.reload();
}

export function orgPermissionsForRole(role: LabRole = getRole()): string[] {
  return ORG_PERMISSIONS[role];
}

/**
 * Owners and admins hold `admin` in every space whatever the panel says: the
 * server resolves their space role from the org role (`resolveSpaceRole`),
 * and refuses an explicit row for them. Serving the picked preset instead
 * would show a combination no real caller can be in.
 */
export function hasFullSpaceAccess(role: LabRole = getRole()): boolean {
  return (ORG_ROLES_WITH_FULL_ACCESS as readonly string[]).includes(role);
}

/** The preset the lab actually serves: the panel's pick, unless the org role overrides it. */
export function effectivePreset(): LabPreset {
  return hasFullSpaceAccess() ? "admin" : getPreset();
}

export function spacePermissionsForPreset(preset: LabPreset = effectivePreset()): string[] {
  return SPACE_PERMISSIONS[preset];
}
