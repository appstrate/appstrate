// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1 golden test — proof that splitting the role matrix into org-level
 * grants plus space-role presets changed no caller's effective permissions.
 *
 * The four snapshots below are the matrix as it stood BEFORE the split
 * (`OWNER/ADMIN/MEMBER/VIEWER_PERMISSIONS` in `src/lib/permissions.ts`, plus
 * the grants every module discovered by the test preload contributed). For
 * every string that existed then, `resolvePermissions(role)` must still
 * answer the same — with two deliberate exceptions:
 *
 *   - `viewer` GAINS `chat:read`. module-chat granted `chat` to
 *     owner/admin/member only, and a read-only preset that cannot read a chat
 *     transcript is a preset with a hole.
 *   - `admin` LOSES `org:update`. No route ever consulted the matrix for it —
 *     the only writer, `PUT /api/orgs/:orgId`, was owner-gated by role name —
 *     so the matrix entry was unreachable and disagreed with RBAC spec §3.4,
 *     which makes renaming the org owner-only. Now that the route reads the
 *     matrix, the entry has to say what the route always did.
 *
 * The test discriminates in both directions: it pins the pre-Phase-1 slice
 * exactly (a widening or a narrowing both fail) AND pins where the newly
 * added strings land (so "nothing changed" cannot be achieved by adding
 * nothing).
 *
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md §12 (Phase 1), §12.1
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { setModulePermissionsProvider } from "@appstrate/core/permissions";
import { collectModulePermissions } from "../../../src/lib/modules/module-loader.ts";
import { getDiscoveredModules } from "../../helpers/test-modules.ts";
import { resolvePermissions, getApiKeyAllowedScopes } from "../../../src/lib/permissions.ts";

/** Core owner grants as they stood before Phase 1. */
const OWNER_CORE_BEFORE = [
  "org:read",
  "org:update",
  "org:delete",
  "members:read",
  "members:invite",
  "members:remove",
  "members:change-role",
  "agents:read",
  "agents:write",
  "agents:configure",
  "agents:delete",
  "agents:run",
  "skills:read",
  "skills:write",
  "skills:delete",
  "runs:read",
  "runs:cancel",
  "runs:delete",
  "files:read",
  "files:delete",
  "mcp-servers:read",
  "mcp-servers:write",
  "mcp-servers:delete",
  "schedules:read",
  "schedules:write",
  "schedules:delete",
  "persistence:read",
  "persistence:delete",
  "models:read",
  "models:write",
  "models:delete",
  "model-provider-credentials:read",
  "model-provider-credentials:write",
  "model-provider-credentials:delete",
  "proxies:read",
  "proxies:write",
  "proxies:delete",
  "api-keys:read",
  "api-keys:create",
  "api-keys:revoke",
  "spaces:read",
  "spaces:write",
  "spaces:delete",
  "end-users:read",
  "end-users:write",
  "end-users:delete",
  "credential-proxy:call",
  "llm-proxy:call",
  "integrations:read",
  "integrations:write",
  "integrations:delete",
  "integrations:install",
  "integrations:uninstall",
  "integrations:connect",
  "integrations:disconnect",
];

/** Module grants (oidc, mcp, webhooks, module-chat) as they stood before Phase 1. */
const OWNER_MODULE_BEFORE = [
  "oauth-clients:read",
  "oauth-clients:write",
  "oauth-clients:delete",
  "cli-sessions:read",
  "cli-sessions:delete",
  "mcp:read",
  "mcp:invoke",
  "webhooks:read",
  "webhooks:write",
  "webhooks:delete",
  "chat:read",
  "chat:write",
];

const OWNER_BEFORE = [...OWNER_CORE_BEFORE, ...OWNER_MODULE_BEFORE];
// `org:update` is the second deliberate change (see the file header).
const ADMIN_BEFORE = OWNER_BEFORE.filter((p) => p !== "org:delete" && p !== "org:update");

const MEMBER_BEFORE = [
  "org:read",
  "members:read",
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
  "models:read",
  "proxies:read",
  "llm-proxy:call",
  "spaces:read",
  "end-users:read",
  "end-users:write",
  "mcp:read",
  "mcp:invoke",
  "chat:read",
  "chat:write",
];

const VIEWER_BEFORE = [
  "org:read",
  "members:read",
  "agents:read",
  "skills:read",
  "mcp-servers:read",
  "runs:read",
  "files:read",
  "schedules:read",
  "persistence:read",
  "models:read",
  "proxies:read",
  "spaces:read",
  "end-users:read",
  "integrations:read",
  "mcp:read",
  // The one deliberate change of Phase 1 (spec §12).
  "chat:read",
];

/**
 * Every permission string that existed before Phase 1. `owner` held all of
 * them, so its snapshot IS the vocabulary — the other three are subsets.
 */
const VOCABULARY_BEFORE = new Set(OWNER_BEFORE);

/** Strings Phase 1 adds, and the roles they must land on. */
const ADDED_FOR_ADMIN_TIER = [
  "org:settings",
  "roles:read",
  "roles:write",
  "roles:delete",
  "space-settings:write",
  "space-members:read",
  "space-members:invite",
  "space-members:remove",
  "space-members:change-role",
  "integrations:configure",
  "org-webhooks:read",
  "org-webhooks:write",
  "org-webhooks:delete",
];

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function beforeSlice(role: "owner" | "admin" | "member" | "viewer"): string[] {
  return sorted([...resolvePermissions(role)].filter((p) => VOCABULARY_BEFORE.has(p)));
}

describe("Phase 1 golden — resolvePermissions is unchanged on the pre-Phase-1 vocabulary", () => {
  beforeAll(() => {
    // Mirror what `getTestApp()` does at boot: aggregate the discovered
    // modules' contributions so `resolvePermissions` sees module grants.
    // Without it the module half of every snapshot below is empty.
    const snapshot = collectModulePermissions(getDiscoveredModules());
    setModulePermissionsProvider(() => snapshot);
  });

  it("the module snapshot is actually loaded (control)", () => {
    // A guard on the guard: if module discovery silently produced nothing,
    // every module assertion below would pass vacuously against an empty set.
    expect(resolvePermissions("owner").has("chat:read" as never)).toBe(true);
    expect(resolvePermissions("owner").has("webhooks:write" as never)).toBe(true);
  });

  it("owner", () => {
    expect(beforeSlice("owner")).toEqual(sorted(OWNER_BEFORE));
  });

  it("admin — owner minus org:delete, minus the deliberate org:update", () => {
    expect(beforeSlice("admin")).toEqual(sorted(ADMIN_BEFORE));
    expect(resolvePermissions("admin").has("org:delete")).toBe(false);
    // Named explicitly so the second exception cannot drift: admin loses the
    // rename, keeps the settings write.
    expect(resolvePermissions("admin").has("org:update")).toBe(false);
    expect(resolvePermissions("admin").has("org:settings")).toBe(true);
    expect(resolvePermissions("owner").has("org:update")).toBe(true);
  });

  it("member", () => {
    expect(beforeSlice("member")).toEqual(sorted(MEMBER_BEFORE));
  });

  it("viewer — unchanged except the deliberate chat:read", () => {
    expect(beforeSlice("viewer")).toEqual(sorted(VIEWER_BEFORE));
    // Named explicitly so the exception cannot be widened silently: chat:read
    // is in, chat:write stays out.
    expect(resolvePermissions("viewer").has("chat:read" as never)).toBe(true);
    expect(resolvePermissions("viewer").has("chat:write" as never)).toBe(false);
  });
});

describe("Phase 1 golden — the new strings land where the spec says", () => {
  beforeAll(() => {
    const snapshot = collectModulePermissions(getDiscoveredModules());
    setModulePermissionsProvider(() => snapshot);
  });

  it("owner and admin hold every string Phase 1 adds", () => {
    for (const permission of ADDED_FOR_ADMIN_TIER) {
      expect(resolvePermissions("owner").has(permission as never)).toBe(true);
      expect(resolvePermissions("admin").has(permission as never)).toBe(true);
    }
  });

  it("member and viewer hold none of them", () => {
    for (const permission of ADDED_FOR_ADMIN_TIER) {
      expect(resolvePermissions("member").has(permission as never)).toBe(false);
      expect(resolvePermissions("viewer").has(permission as never)).toBe(false);
    }
  });

  it("member and viewer gain nothing at all beyond the pre-Phase-1 vocabulary", () => {
    // The strongest form of "zero behaviour change" for the two non-admin
    // roles: their whole effective set is still inside the old vocabulary.
    for (const role of ["member", "viewer"] as const) {
      const outside = sorted(
        [...resolvePermissions(role)].filter((p) => !VOCABULARY_BEFORE.has(p)),
      );
      expect(outside).toEqual([]);
    }
  });

  it("the reachable presets nest: viewer ⊂ operator ⊂ admin", () => {
    // Phase 1 maps viewer → preset viewer, member → operator, owner/admin →
    // preset admin, so the org roles are the observable of the preset
    // ordering. (`builder` holds no org role yet; it is `admin` minus three
    // prefixes by construction, and `operator` carries none of them.)
    const viewer = resolvePermissions("viewer");
    const member = resolvePermissions("member");
    const owner = resolvePermissions("owner");
    for (const p of viewer) expect(member.has(p)).toBe(true);
    for (const p of member) expect(owner.has(p)).toBe(true);
    expect(viewer.size).toBeLessThan(member.size);
    expect(member.size).toBeLessThan(owner.size);
  });

  it("none of the new session-only strings is API-key-grantable", () => {
    const allowed = getApiKeyAllowedScopes();
    for (const permission of [
      "org:settings",
      "roles:read",
      "roles:write",
      "roles:delete",
      "space-settings:write",
      "space-members:read",
      "space-members:invite",
      "space-members:remove",
      "space-members:change-role",
      "integrations:configure",
    ]) {
      expect(allowed.has(permission)).toBe(false);
    }
    // `org-webhooks:*` is NOT grantable either: an API key always resolves to
    // a SpaceScope and can never reach an org-level row. The space half keeps
    // the opt-in the resource it was split out of had.
    expect(allowed.has("org-webhooks:write")).toBe(false);
    expect(allowed.has("webhooks:write")).toBe(true);
  });
});
