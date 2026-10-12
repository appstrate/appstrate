// SPDX-License-Identifier: Apache-2.0

/**
 * The credential proxy has two permissions. `credential-proxy:call`,
 * the call for a run, is held by `admin` and `builder`. `credential-proxy:direct`,
 * the call outside a run, is held by `admin` alone: below it a custom space role
 * grants it, and an API key carries it only from a creator who holds it.
 */

import { describe, expect, it } from "bun:test";
import { SPACE_LEVEL_PERMISSIONS, SPACE_ROLE_PRESETS } from "@appstrate/core/permissions";
import {
  API_KEY_ALLOWED_SCOPES,
  effectivePermissions,
  knownSpaceLevelPermissions,
  missingReadGrants,
  orgPermissions,
  presetPermissions,
  spaceLevelVocabulary,
  validateScopes,
} from "../../../src/lib/permissions.ts";
import { resolveSpaceRole, spacePermissions } from "../../../src/lib/space-role.ts";

const CALL = "credential-proxy:call";
const DIRECT = "credential-proxy:direct";

const presetsHolding = (permission: typeof CALL | typeof DIRECT) =>
  SPACE_ROLE_PRESETS.filter((preset) => presetPermissions(preset).has(permission));

describe("credential-proxy:call", () => {
  it("is held by `admin` and `builder`, and is API-key grantable", () => {
    expect(presetsHolding(CALL)).toEqual(["admin", "builder"]);
    expect(API_KEY_ALLOWED_SCOPES.has(CALL)).toBe(true);
    expect(validateScopes([CALL], presetPermissions("builder"))).toEqual([CALL]);
    expect(validateScopes([CALL], presetPermissions("operator"))).toEqual([]);
  });

  it("does not carry the call outside a run", () => {
    expect(validateScopes([CALL, DIRECT], presetPermissions("builder"))).toEqual([CALL]);
  });
});

describe("credential-proxy:direct", () => {
  it("is held by `admin` and by no other preset", () => {
    expect(presetsHolding(DIRECT)).toEqual(["admin"]);
  });

  it("is the one core permission `builder` lacks outside the governance families", () => {
    // `builder` derives from `admin`, so what it lacks is its exclusions and
    // nothing else: the three governance families, and this string.
    const builder = presetPermissions("builder");
    const governance = ["space-settings:", "space-members:", "api-keys:"];
    const lacking = [...SPACE_LEVEL_PERMISSIONS].filter(
      (permission) =>
        !builder.has(permission) && !governance.some((prefix) => permission.startsWith(prefix)),
    );
    expect(lacking).toEqual([DIRECT]);
  });

  it("reaches an org owner or admin in any team space, and no member through a default role", () => {
    const inOpenSpace = (role: Parameters<typeof orgPermissions>[0]) =>
      effectivePermissions({
        orgPermissions: orgPermissions(role),
        spacePermissions: spacePermissions(
          resolveSpaceRole(
            role,
            { id: "spc_test", visibility: "open", defaultRole: "builder", ownerUserId: null },
            null,
            "usr_test",
          ),
        ),
      });
    expect(inOpenSpace("owner").has(DIRECT)).toBe(true);
    expect(inOpenSpace("admin").has(DIRECT)).toBe(true);
    // The widest default a space can hand a member is not `admin`'s.
    expect(inOpenSpace("member").has(DIRECT)).toBe(false);
    expect(inOpenSpace("guest").has(DIRECT)).toBe(false);
  });

  it("is granted by a custom role holding it, alone", () => {
    expect(knownSpaceLevelPermissions().has(DIRECT)).toBe(true);
    // The resource has no read action, so the bundle needs nothing beside it.
    expect(missingReadGrants([DIRECT])).toEqual([]);
    const ref = resolveSpaceRole(
      "member",
      { id: "spc_test", visibility: "open", defaultRole: "operator", ownerUserId: null },
      {
        ref: {
          kind: "custom",
          role: { id: "srl_test", key: "proxy", name: "Proxy", permissions: [DIRECT] },
        },
      },
      "usr_test",
    );
    expect([...spacePermissions(ref)]).toEqual([DIRECT]);
  });

  it("is offered by the role editor's vocabulary as key-grantable", () => {
    const entry = spaceLevelVocabulary()
      .find((group) => group.resource === "credential-proxy")
      ?.permissions.find((candidate) => candidate.permission === DIRECT);
    expect(entry).toEqual({
      permission: DIRECT,
      action: "direct",
      api_key_grantable: true,
      requires_one_of: [],
    });
  });

  it("is API-key grantable, and only to a creator who holds it", () => {
    expect(API_KEY_ALLOWED_SCOPES.has(DIRECT)).toBe(true);
    expect(validateScopes([DIRECT], new Set([DIRECT]))).toEqual([DIRECT]);
    expect(validateScopes(["agents:read", DIRECT], presetPermissions("admin"))).toEqual([
      "agents:read",
      DIRECT,
    ]);
    // A builder does not hold it: the scope narrows away at mint, as any grant
    // above the creator does.
    expect(validateScopes(["agents:read", DIRECT], presetPermissions("builder"))).toEqual([
      "agents:read",
    ]);
  });

  it("is not carried by a key listing it once its creator is a builder", () => {
    // The ceiling caps, it never grants: a key minted by an admin since made
    // `builder` keeps the scope in its list and loses the permission.
    const through = (preset: "admin" | "builder") =>
      effectivePermissions({
        orgPermissions: orgPermissions("member"),
        spacePermissions: presetPermissions(preset),
        scopeCeiling: new Set(["agents:read", DIRECT]),
      });
    expect([...through("admin")].sort()).toEqual(["agents:read", DIRECT]);
    expect([...through("builder")]).toEqual(["agents:read"]);
  });
});
