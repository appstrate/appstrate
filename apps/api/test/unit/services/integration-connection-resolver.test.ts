// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure `resolveConnections()` function — the cascade
 * that decides which connection a run uses per integration. One connection
 * per integration: the chosen row carries its own `authKey`, OAuth and
 * api_key are interchangeable.
 *
 * Pure function, no DB. All inputs are arrays + plain objects.
 *
 * Cascade order (highest → lowest):
 *   1. integration_pins (user_id IS NULL)        → admin force, per-agent
 *   2. integration_org_defaults (enforce)        → org-wide force
 *   3. runs.connection_overrides                 → caller's run-time choice
 *   4. package_schedules.connection_overrides    → schedule frozen
 *   5. integration_pins (user_id = actor.id)     → member preference
 *   6. integration_org_defaults (soft)           → org-wide default
 *   7. fallback: own + shared accessible
 *      → 1 match = auto, 0 = not_connected, N = must_choose
 */

import { describe, it, expect } from "bun:test";
import {
  resolveConnections,
  type IntegrationRequirement,
} from "../../../src/services/integration-connection-resolver.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type {
  IntegrationConnectionRow as ConnectionRow,
  IntegrationPinRow as PinRow,
} from "@appstrate/db/schema";

// ─────────────────────────── Fixtures ─────────────────────────────────────────

const INTEG = "@vendor/test-integ";
const APP_ID = "app_test";
const USER_ID = "user_alice";
const AGENT_ID = "@vendor/test-agent";

function oauth2Manifest(): IntegrationManifest {
  return {
    type: "integration",
    schema_version: "0.1",
    name: INTEG,
    version: "1.0.0",
    display_name: "Test",
    source: { kind: "local", server: { name: "@vendor/test-server", version: "^1.0.0" } },
    auths: {
      oauth: {
        type: "oauth2",
        authorization_endpoint: "https://idp/auth",
        token_endpoint: "https://idp/token",
        default_scopes: [],
        authorized_uris: ["https://api.example.com/**"],
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.access_token}",
          },
        },
      },
    },
    tools: {},
  } as unknown as IntegrationManifest;
}

let connId = 0;
function conn(input: Partial<ConnectionRow> & { authKey?: string }): ConnectionRow {
  connId += 1;
  return {
    id: `conn_${connId}`,
    integrationId: INTEG,
    authKey: input.authKey ?? "oauth",
    accountId: "acc_x",
    applicationId: APP_ID,
    userId: USER_ID,
    endUserId: null,
    credentialsEncrypted: "ciphertext",
    identityClaims: null,
    scopesGranted: [],
    needsReconnection: false,
    expiresAt: null,
    label: null,
    sharedWithOrg: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...input,
  } as ConnectionRow;
}

let pinSeq = 0;
function pin(connectionId: string, opts?: { userId?: string | null }): PinRow {
  pinSeq += 1;
  return {
    id: `pin_${pinSeq}`,
    applicationId: APP_ID,
    packageId: AGENT_ID,
    integrationId: INTEG,
    userId: opts?.userId ?? null,
    connectionId,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Sugar — member pin scoped to the test's default user. */
function memberPin(connectionId: string): PinRow {
  return pin(connectionId, { userId: USER_ID });
}

function req(
  manifest: IntegrationManifest,
  agentTools: string[] = [],
  agentScopes: string[] = [],
): IntegrationRequirement {
  return {
    integrationId: INTEG,
    manifest,
    hasSelectedTools: true,
    agentTools,
    agentScopes,
  };
}

// ─────────────────────────── Cascade tests ────────────────────────────────────

describe("resolveConnections — admin pin (cascade layer 1)", () => {
  it("uses the pinned connection when present and accessible", () => {
    const c = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [pin(c.id)],
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]).toEqual({
      connectionId: c.id,
      source: "admin_pin",
      label: null,
      accountId: "acc_x",
    });
  });

  it("emits pinned_connection_unavailable when the pin points at an invisible connection", () => {
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [],
      pins: [pin("conn_ghost")],
    });
    expect(result.resolved[INTEG]).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe("pinned_connection_unavailable");
  });

  it("pin wins over run override", () => {
    const pinned = conn({});
    const overridden = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [pinned, overridden],
      pins: [pin(pinned.id)],
      runOverrides: { [INTEG]: overridden.id },
    });
    expect(result.resolved[INTEG]!.connectionId).toBe(pinned.id);
    expect(result.resolved[INTEG]!.source).toBe("admin_pin");
  });

  it("pin wins over schedule override", () => {
    const pinned = conn({});
    const sched = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [pinned, sched],
      pins: [pin(pinned.id)],
      scheduleOverrides: { [INTEG]: sched.id },
    });
    expect(result.resolved[INTEG]!.source).toBe("admin_pin");
  });

  it("pin on a DIFFERENT auth shape still wins (oauth pin overrides agent's pat default)", () => {
    // The reason the flat model exists: a PAT-pinned connection MUST win
    // even when the agent's tools nominally scope their required_scopes to oauth.
    const patConn = conn({ authKey: "pat" });
    const oauthConn = conn({ authKey: "oauth" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [patConn, oauthConn],
      pins: [pin(patConn.id)],
    });
    expect(result.resolved[INTEG]!.connectionId).toBe(patConn.id);
    expect(result.resolved[INTEG]!.source).toBe("admin_pin");
  });
});

describe("resolveConnections — run override (cascade layer 2)", () => {
  it("uses run override when no pin", () => {
    const c = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [],
      runOverrides: { [INTEG]: c.id },
    });
    expect(result.resolved[INTEG]).toEqual({
      connectionId: c.id,
      source: "run_override",
      label: null,
      accountId: "acc_x",
    });
  });

  it("run override wins over schedule override", () => {
    const runChoice = conn({});
    const sched = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [runChoice, sched],
      pins: [],
      runOverrides: { [INTEG]: runChoice.id },
      scheduleOverrides: { [INTEG]: sched.id },
    });
    expect(result.resolved[INTEG]!.source).toBe("run_override");
  });

  it("emits override_connection_unavailable when the override points nowhere", () => {
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [],
      pins: [],
      runOverrides: { [INTEG]: "conn_ghost" },
    });
    expect(result.errors[0]!.code).toBe("override_connection_unavailable");
  });
});

describe("resolveConnections — schedule override (cascade layer 3)", () => {
  it("uses schedule override when no pin or run override", () => {
    const c = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [],
      scheduleOverrides: { [INTEG]: c.id },
    });
    expect(result.resolved[INTEG]!.source).toBe("schedule_override");
  });
});

describe("resolveConnections — member pin (cascade layer 4)", () => {
  it("uses member pin when no admin pin / no overrides and actor matches", () => {
    const c = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [memberPin(c.id)],
      actorUserId: USER_ID,
    });
    expect(result.resolved[INTEG]).toEqual({
      connectionId: c.id,
      source: "member_pin",
      label: null,
      accountId: "acc_x",
    });
  });

  it("member pin scoped to OTHER actor is ignored — falls through to fallback", () => {
    const c = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [pin(c.id, { userId: "user_someone_else" })],
      actorUserId: USER_ID,
    });
    expect(result.resolved[INTEG]!.source).toBe("fallback_auto");
  });

  it("admin pin wins over member pin (same agent, same integration)", () => {
    const adminChoice = conn({});
    const memberChoice = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [adminChoice, memberChoice],
      pins: [pin(adminChoice.id), memberPin(memberChoice.id)],
      actorUserId: USER_ID,
    });
    expect(result.resolved[INTEG]!.connectionId).toBe(adminChoice.id);
    expect(result.resolved[INTEG]!.source).toBe("admin_pin");
  });

  it("run override wins over member pin", () => {
    const memberChoice = conn({});
    const runChoice = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [memberChoice, runChoice],
      pins: [memberPin(memberChoice.id)],
      runOverrides: { [INTEG]: runChoice.id },
      actorUserId: USER_ID,
    });
    expect(result.resolved[INTEG]!.source).toBe("run_override");
  });

  it("member pin wins over the >1 fallback ambiguity", () => {
    const picked = conn({});
    const other = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [picked, other],
      pins: [memberPin(picked.id)],
      actorUserId: USER_ID,
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]!.connectionId).toBe(picked.id);
    expect(result.resolved[INTEG]!.source).toBe("member_pin");
  });

  it("emits pinned_connection_unavailable when the member pin points at a vanished connection", () => {
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [],
      pins: [memberPin("conn_ghost")],
      actorUserId: USER_ID,
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe("pinned_connection_unavailable");
  });

  it("end-user run (actorUserId=null) ignores all member pins", () => {
    const c = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [memberPin(c.id)],
      actorUserId: null,
    });
    expect(result.resolved[INTEG]!.source).toBe("fallback_auto");
  });
});

describe("resolveConnections — fallback (cascade layer 5)", () => {
  it("auto-picks the single accessible connection", () => {
    const c = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [],
    });
    expect(result.resolved[INTEG]).toEqual({
      connectionId: c.id,
      source: "fallback_auto",
      label: null,
      accountId: "acc_x",
    });
  });

  it("includes shared connections in the candidate set", () => {
    const adminShared = conn({ userId: "user_admin", sharedWithOrg: true });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [adminShared],
      pins: [],
    });
    expect(result.resolved[INTEG]!.connectionId).toBe(adminShared.id);
    expect(result.resolved[INTEG]!.source).toBe("fallback_auto");
  });

  it("emits not_connected when nothing matches", () => {
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [],
      pins: [],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe("not_connected");
    expect(result.errors[0]!.integrationId).toBe(INTEG);
  });

  it("emits must_choose_connection when >1 candidate (any auth shape)", () => {
    const a = conn({});
    const b = conn({ authKey: "pat" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [a, b],
      pins: [],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe("must_choose_connection");
    expect(result.errors[0]!.candidateConnectionIds).toEqual(expect.arrayContaining([a.id, b.id]));
  });
});

describe("resolveConnections — health checks", () => {
  it("emits needs_reconnection when the chosen connection is flagged", () => {
    const c = conn({ needsReconnection: true });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [],
    });
    expect(result.errors[0]!.code).toBe("needs_reconnection");
    // Surface the dead connection id so the reconnect modal can pass it
    // through the OAuth callback (update existing row, not insert duplicate).
    expect(result.errors[0]!.connectionId).toBe(c.id);
  });

  it("needs_reconnection fires for pinned + override paths too", () => {
    const c = conn({ needsReconnection: true });
    const pinResult = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [pin(c.id)],
    });
    expect(pinResult.errors[0]!.code).toBe("needs_reconnection");
    expect(pinResult.errors[0]!.connectionId).toBe(c.id);
  });
});

describe("resolveConnections — multi-integration", () => {
  it("handles each integration independently", () => {
    const INTEG2 = "@vendor/other-integ";
    const c1 = conn({});
    const c2 = conn({ integrationId: INTEG2 });
    const m2: IntegrationManifest = {
      ...oauth2Manifest(),
      name: INTEG2,
    } as IntegrationManifest;

    const result = resolveConnections({
      requirements: [
        req(oauth2Manifest()),
        {
          integrationId: INTEG2,
          manifest: m2,
          hasSelectedTools: true,
          agentTools: [],
          agentScopes: [],
        },
      ],
      accessibleConnections: [c1, c2],
      pins: [],
    });
    expect(result.resolved[INTEG]!.connectionId).toBe(c1.id);
    expect(result.resolved[INTEG2]!.connectionId).toBe(c2.id);
  });

  it("partial resolution: integration A succeeds, B errors", () => {
    const INTEG2 = "@vendor/other";
    const c1 = conn({});
    const m2: IntegrationManifest = { ...oauth2Manifest(), name: INTEG2 } as IntegrationManifest;
    const result = resolveConnections({
      requirements: [
        req(oauth2Manifest()),
        {
          integrationId: INTEG2,
          manifest: m2,
          hasSelectedTools: true,
          agentTools: [],
          agentScopes: [],
        },
      ],
      accessibleConnections: [c1],
      pins: [],
    });
    expect(result.resolved[INTEG]).toBeDefined();
    expect(result.resolved[INTEG2]).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.integrationId).toBe(INTEG2);
  });
});

describe("resolveConnections — empty requirements / inert integrations", () => {
  it("returns empty result when no requirements", () => {
    const result = resolveConnections({
      requirements: [],
      accessibleConnections: [],
      pins: [],
    });
    expect(result.resolved).toEqual({});
    expect(result.errors).toEqual([]);
  });

  it("skips integrations with no selected tools (declared-but-inert)", () => {
    const result = resolveConnections({
      requirements: [
        {
          integrationId: INTEG,
          manifest: oauth2Manifest(),
          hasSelectedTools: false,
          agentTools: [],
          agentScopes: [],
        },
      ],
      accessibleConnections: [],
      pins: [],
    });
    expect(result.resolved).toEqual({});
    expect(result.errors).toEqual([]);
  });
});

describe("resolveConnections — insufficient scopes on resolved connection", () => {
  // Manifest where tool `t1` requires the `repo` scope on the oauth auth.
  function scopedManifest(): IntegrationManifest {
    return {
      type: "integration",
      schema_version: "0.1",
      name: INTEG,
      version: "1.0.0",
      display_name: "Test",
      source: { kind: "local", server: { name: "@vendor/test-server", version: "^1.0.0" } },
      auths: {
        oauth: {
          type: "oauth2",
          authorization_endpoint: "https://idp/auth",
          token_endpoint: "https://idp/token",
          default_scopes: [],
          scope_catalog: [{ value: "repo", label: "Repo" }],
          authorized_uris: ["https://api.example.com/**"],
          delivery: {
            http: {
              in: "header",
              name: "Authorization",
              prefix: "Bearer ",
              value: "{$credential.access_token}",
            },
          },
        },
      },
      tools_policy: { t1: { required_scopes: { oauth: ["repo"] } } },
    } as unknown as IntegrationManifest;
  }

  it("blocks when the resolved own connection lacks a required scope (ownedByActor=true)", () => {
    const c = conn({ scopesGranted: [] });
    const result = resolveConnections({
      requirements: [req(scopedManifest(), ["t1"])],
      accessibleConnections: [c],
      pins: [],
      actorUserId: USER_ID,
    });
    expect(result.resolved[INTEG]).toBeUndefined();
    const err = result.errors[0]!;
    expect(err.code).toBe("insufficient_scopes");
    expect(err.connectionId).toBe(c.id);
    expect(err.missingScopes).toEqual(["repo"]);
    expect(err.ownedByActor).toBe(true);
  });

  it("resolves when the connection already grants the required scope", () => {
    const c = conn({ scopesGranted: ["repo"] });
    const result = resolveConnections({
      requirements: [req(scopedManifest(), ["t1"])],
      accessibleConnections: [c],
      pins: [],
      actorUserId: USER_ID,
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]?.connectionId).toBe(c.id);
  });

  it("flags ownedByActor=false when the under-scoped connection belongs to someone else", () => {
    const foreign = conn({ userId: "user_someone_else", sharedWithOrg: true, scopesGranted: [] });
    const result = resolveConnections({
      requirements: [req(scopedManifest(), ["t1"])],
      accessibleConnections: [foreign],
      pins: [pin(foreign.id, { userId: USER_ID })],
      actorUserId: USER_ID,
    });
    const err = result.errors[0]!;
    expect(err.code).toBe("insufficient_scopes");
    expect(err.ownedByActor).toBe(false);
  });
});

// ─────────────────────────── Org default (layers 2 & 6) ───────────────────────

describe("resolveConnections — org default", () => {
  const ENFORCE = (id: string) => ({ [INTEG]: { connectionId: id, enforce: true } });
  const SOFT = (id: string) => ({ [INTEG]: { connectionId: id, enforce: false } });

  it("ENFORCE default wins over run override, schedule override, and member pin", () => {
    const def = conn({ sharedWithOrg: true });
    const other = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [def, other],
      pins: [memberPin(other.id)],
      runOverrides: { [INTEG]: other.id },
      scheduleOverrides: { [INTEG]: other.id },
      orgDefaults: ENFORCE(def.id),
      actorUserId: USER_ID,
    });
    expect(result.resolved[INTEG]).toEqual({
      connectionId: def.id,
      source: "org_default_enforced",
      label: null,
      accountId: "acc_x",
    });
  });

  it("per-agent admin pin beats the ENFORCE org default (agent-specific exception)", () => {
    const pinned = conn({});
    const def = conn({ sharedWithOrg: true });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [pinned, def],
      pins: [pin(pinned.id)],
      orgDefaults: ENFORCE(def.id),
    });
    expect(result.resolved[INTEG]!.source).toBe("admin_pin");
    expect(result.resolved[INTEG]!.connectionId).toBe(pinned.id);
  });

  it("ENFORCE default with an invisible connection → pinned_connection_unavailable", () => {
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [],
      pins: [],
      orgDefaults: ENFORCE("conn_ghost"),
    });
    expect(result.resolved[INTEG]).toBeUndefined();
    expect(result.errors[0]!.code).toBe("pinned_connection_unavailable");
  });

  it("SOFT default kills must_choose: used when N candidates and no pin/override", () => {
    const def = conn({ sharedWithOrg: true });
    const otherA = conn({});
    const otherB = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [def, otherA, otherB],
      pins: [],
      orgDefaults: SOFT(def.id),
      actorUserId: USER_ID,
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]).toEqual({
      connectionId: def.id,
      source: "org_default",
      label: null,
      accountId: "acc_x",
    });
  });

  it("member pin beats the SOFT default (explicit preference wins)", () => {
    const def = conn({ sharedWithOrg: true });
    const mine = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [def, mine],
      pins: [memberPin(mine.id)],
      orgDefaults: SOFT(def.id),
      actorUserId: USER_ID,
    });
    expect(result.resolved[INTEG]!.source).toBe("member_pin");
    expect(result.resolved[INTEG]!.connectionId).toBe(mine.id);
  });

  it("SOFT default falls through to fallback when its connection is gone (non-binding)", () => {
    const onlyOne = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [onlyOne],
      pins: [],
      orgDefaults: SOFT("conn_ghost"),
      actorUserId: USER_ID,
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]).toEqual({
      connectionId: onlyOne.id,
      source: "fallback_auto",
      label: null,
      accountId: "acc_x",
    });
  });

  it("a scope-deficient org default surfaces insufficient_scopes (checkHealth still runs)", () => {
    const manifest = {
      type: "integration",
      schema_version: "0.1",
      name: INTEG,
      version: "1.0.0",
      display_name: "Test",
      source: { kind: "local", server: { name: "@vendor/test-server", version: "^1.0.0" } },
      auths: {
        oauth: {
          type: "oauth2",
          authorization_endpoint: "https://idp/auth",
          token_endpoint: "https://idp/token",
          default_scopes: [],
          scope_catalog: [{ value: "repo", label: "Repo" }],
          authorized_uris: ["https://api.example.com/**"],
          delivery: {
            http: {
              in: "header",
              name: "Authorization",
              prefix: "Bearer ",
              value: "{$credential.access_token}",
            },
          },
        },
      },
      tools_policy: { t1: { required_scopes: { oauth: ["repo"] } } },
    } as unknown as IntegrationManifest;
    const def = conn({ sharedWithOrg: true, scopesGranted: [] });
    const result = resolveConnections({
      requirements: [req(manifest, ["t1"])],
      accessibleConnections: [def],
      pins: [],
      orgDefaults: ENFORCE(def.id),
    });
    expect(result.resolved[INTEG]).toBeUndefined();
    expect(result.errors[0]!.code).toBe("insufficient_scopes");
  });
});

// ─────────────────────── AFPS §4.1 `auth_key` ─────────────────────────────

describe("resolveConnections — agent dep `auth_key` (AFPS §4.1)", () => {
  function reqWithAuthKey(authKey: string): IntegrationRequirement {
    return {
      integrationId: INTEG,
      manifest: oauth2Manifest(),
      hasSelectedTools: true,
      agentTools: [],
      agentScopes: [],
      requiredAuthKey: authKey,
    };
  }

  it("picks the matching-auth connection when the agent dep pins `auth_key: 'pat'`", () => {
    const oauthConn = conn({ authKey: "oauth" });
    const patConn = conn({ authKey: "pat" });
    const result = resolveConnections({
      requirements: [reqWithAuthKey("pat")],
      accessibleConnections: [oauthConn, patConn],
      pins: [],
      actorUserId: USER_ID,
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]!.connectionId).toBe(patConn.id);
    expect(result.resolved[INTEG]!.source).toBe("fallback_auto");
  });

  it("falls back to existing cascade when no `auth_key` is pinned (parity with prior behavior)", () => {
    const oauthConn = conn({ authKey: "oauth" });
    const patConn = conn({ authKey: "pat" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [oauthConn, patConn],
      pins: [],
      actorUserId: USER_ID,
    });
    // No pin/override + 2 candidates ⇒ must_choose. The point: the resolver
    // SAW both candidates (no auth_key filter pre-narrowed them).
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe("must_choose_connection");
    expect(result.errors[0]!.candidateConnectionIds).toEqual(
      expect.arrayContaining([oauthConn.id, patConn.id]),
    );
  });

  it("surfaces `auth_key_mismatch` when the agent dep pins a nonexistent auth_key", () => {
    const oauthConn = conn({ authKey: "oauth" });
    const result = resolveConnections({
      requirements: [reqWithAuthKey("nonexistent")],
      accessibleConnections: [oauthConn],
      pins: [],
      actorUserId: USER_ID,
    });
    expect(result.resolved[INTEG]).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    const err = result.errors[0]!;
    expect(err.code).toBe("auth_key_mismatch");
    expect(err.integrationId).toBe(INTEG);
    expect(err.requiredAuthKey).toBe("nonexistent");
    expect(err.availableAuthKeys).toEqual(["oauth"]);
  });

  it("surfaces `not_connected` (not auth_key_mismatch) when actor has no connections at all", () => {
    const result = resolveConnections({
      requirements: [reqWithAuthKey("pat")],
      accessibleConnections: [],
      pins: [],
      actorUserId: USER_ID,
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe("not_connected");
  });

  it("filters BEFORE the cascade — admin pin pointing at off-auth connection is dropped", () => {
    // The pin points at oauth, but the dep requires pat. The pre-filter removes
    // the oauth row from the candidate set, so the admin pin can't be resolved
    // ⇒ pinned_connection_unavailable (not a happy-path resolve).
    const oauthConn = conn({ authKey: "oauth" });
    const patConn = conn({ authKey: "pat" });
    const result = resolveConnections({
      requirements: [reqWithAuthKey("pat")],
      accessibleConnections: [oauthConn, patConn],
      pins: [pin(oauthConn.id)],
      actorUserId: USER_ID,
    });
    // The pin pointed at the now-filtered-out oauth row, so it resolves
    // as `pinned_connection_unavailable`.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe("pinned_connection_unavailable");
  });
});
