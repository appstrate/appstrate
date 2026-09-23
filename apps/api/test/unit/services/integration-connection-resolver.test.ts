// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure `resolveConnections()` function — the cascade
 * that decides which connectionS a run binds per integration. Every layer
 * yields a SET; each chosen row carries its own `authKey`, OAuth and
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
  translateResolutionError,
  type IntegrationRequirement,
} from "../../../src/services/integration-connection-resolver.ts";
import { connectOfferTarget } from "../../../src/services/connect/preflight-connect-offer.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type {
  IntegrationConnectionRow as ConnectionRow,
  IntegrationPinRow as PinRow,
} from "@appstrate/db/schema";

// ─────────────────────────── Fixtures ─────────────────────────────────────────

const INTEG = "@vendor/test-integ";
const SPACE_ID = "spc_test";
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
      // A second declared auth shape. The cascade tests inject `pat`
      // connections to exercise multi-auth resolution; both keys must exist
      // in the manifest (a connection only exists for a declared auth — the
      // orphaned-auth guard drops rows whose authKey the manifest dropped).
      pat: {
        type: "api_key",
        authorized_uris: ["https://api.example.com/**"],
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.api_key}",
          },
        },
      },
    },
    tools: {},
  } as unknown as IntegrationManifest;
}

/** oauth2Manifest + the vendor `_meta["dev.appstrate/auth"].required` flag. */
function requiredOauth2Manifest(): IntegrationManifest {
  const m = oauth2Manifest() as unknown as { auths: { oauth: Record<string, unknown> } };
  m.auths.oauth._meta = { "dev.appstrate/auth": { required: true } };
  return m as unknown as IntegrationManifest;
}

let connId = 0;
function conn(input: Partial<ConnectionRow> & { authKey?: string }): ConnectionRow {
  connId += 1;
  return {
    id: `conn_${connId}`,
    integrationId: INTEG,
    authKey: input.authKey ?? "oauth",
    accountId: "acc_x",
    spaceId: SPACE_ID,
    userId: USER_ID,
    endUserId: null,
    credentialsEncrypted: "ciphertext",
    identityClaims: null,
    scopesGranted: [],
    needsReconnection: false,
    expiresAt: null,
    // NOT NULL in `integration_connections`: the sidecar keys its `connection`
    // tool parameter on this value, so a nameless row is unaddressable.
    label: `conn-${connId}`,
    sharedWithOrg: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...input,
  } as ConnectionRow;
}

let pinSeq = 0;
/** One pin row — the whole bound set of its (agent, integration, scope). */
function pin(connectionIds: string | string[], opts?: { userId?: string | null }): PinRow {
  pinSeq += 1;
  return {
    id: `pin_${pinSeq}`,
    spaceId: SPACE_ID,
    packageId: AGENT_ID,
    integrationId: INTEG,
    userId: opts?.userId ?? null,
    connectionIds: typeof connectionIds === "string" ? [connectionIds] : connectionIds,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Sugar — member pin scoped to the test's default user. */
function memberPin(connectionIds: string | string[]): PinRow {
  return pin(connectionIds, { userId: USER_ID });
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
    expect(result.resolved[INTEG]).toEqual([
      {
        connectionId: c.id,
        source: "admin_pin",
        label: c.label,
        accountId: "acc_x",
      },
    ]);
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
    expect(result.errors[0]!.message).toContain("may have been deleted");
  });

  it("pin wins over run override", () => {
    const pinned = conn({});
    const overridden = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [pinned, overridden],
      pins: [pin(pinned.id)],
      runOverrides: { [INTEG]: [overridden.id] },
    });
    expect(result.resolved[INTEG]![0]!.connectionId).toBe(pinned.id);
    expect(result.resolved[INTEG]![0]!.source).toBe("admin_pin");
  });

  it("pin wins over schedule override", () => {
    const pinned = conn({});
    const sched = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [pinned, sched],
      pins: [pin(pinned.id)],
      scheduleOverrides: { [INTEG]: [sched.id] },
    });
    expect(result.resolved[INTEG]![0]!.source).toBe("admin_pin");
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
    expect(result.resolved[INTEG]![0]!.connectionId).toBe(patConn.id);
    expect(result.resolved[INTEG]![0]!.source).toBe("admin_pin");
  });
});

describe("resolveConnections — run override (cascade layer 3)", () => {
  it("uses run override when no pin", () => {
    const c = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [],
      runOverrides: { [INTEG]: [c.id] },
    });
    expect(result.resolved[INTEG]).toEqual([
      {
        connectionId: c.id,
        source: "run_override",
        label: c.label,
        accountId: "acc_x",
      },
    ]);
  });

  it("run override wins over schedule override", () => {
    const runChoice = conn({});
    const sched = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [runChoice, sched],
      pins: [],
      runOverrides: { [INTEG]: [runChoice.id] },
      scheduleOverrides: { [INTEG]: [sched.id] },
    });
    expect(result.resolved[INTEG]![0]!.source).toBe("run_override");
  });

  it("emits override_connection_unavailable when the override points nowhere", () => {
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [],
      pins: [],
      runOverrides: { [INTEG]: ["conn_ghost"] },
    });
    expect(result.errors[0]!.code).toBe("override_connection_unavailable");
  });
});

describe("resolveConnections — schedule override (cascade layer 4)", () => {
  it("uses schedule override when no pin or run override", () => {
    const c = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [],
      scheduleOverrides: { [INTEG]: [c.id] },
    });
    expect(result.resolved[INTEG]![0]!.source).toBe("schedule_override");
  });
});

describe("resolveConnections — member pin (cascade layer 5)", () => {
  it("uses member pin when no admin pin / no overrides and actor matches", () => {
    const c = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [memberPin(c.id)],
      actorUserId: USER_ID,
    });
    expect(result.resolved[INTEG]).toEqual([
      {
        connectionId: c.id,
        source: "member_pin",
        label: c.label,
        accountId: "acc_x",
      },
    ]);
  });

  it("member pin scoped to OTHER actor is ignored — falls through to fallback", () => {
    const c = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [pin(c.id, { userId: "user_someone_else" })],
      actorUserId: USER_ID,
    });
    expect(result.resolved[INTEG]![0]!.source).toBe("fallback_auto");
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
    expect(result.resolved[INTEG]![0]!.connectionId).toBe(adminChoice.id);
    expect(result.resolved[INTEG]![0]!.source).toBe("admin_pin");
  });

  it("run override wins over member pin", () => {
    const memberChoice = conn({});
    const runChoice = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [memberChoice, runChoice],
      pins: [memberPin(memberChoice.id)],
      runOverrides: { [INTEG]: [runChoice.id] },
      actorUserId: USER_ID,
    });
    expect(result.resolved[INTEG]![0]!.source).toBe("run_override");
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
    expect(result.resolved[INTEG]![0]!.connectionId).toBe(picked.id);
    expect(result.resolved[INTEG]![0]!.source).toBe("member_pin");
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
    expect(result.resolved[INTEG]![0]!.source).toBe("fallback_auto");
  });
});

describe("resolveConnections — fallback (cascade layer 7)", () => {
  it("auto-picks the single accessible connection", () => {
    const c = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [],
    });
    expect(result.resolved[INTEG]).toEqual([
      {
        connectionId: c.id,
        source: "fallback_auto",
        label: c.label,
        accountId: "acc_x",
      },
    ]);
  });

  it("includes shared connections in the candidate set", () => {
    const adminShared = conn({ userId: "user_admin", sharedWithOrg: true });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [adminShared],
      pins: [],
    });
    expect(result.resolved[INTEG]![0]!.connectionId).toBe(adminShared.id);
    expect(result.resolved[INTEG]![0]!.source).toBe("fallback_auto");
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
    expect(result.errors[0]!.candidateConnections?.map((c) => c.id)).toEqual(
      expect.arrayContaining([a.id, b.id]),
    );
  });

  it("must_choose candidates carry what tells them apart, not just ids", () => {
    // The whole point of the payload: a caller with no picker (API, MCP) must
    // be able to choose from the error alone. Two rows differing only by label
    // and ownership are indistinguishable by id.
    const mine = conn({ label: "web server", accountId: "root@web-01" });
    const shared = conn({
      authKey: "pat",
      label: "database",
      accountId: "root@db-01",
      userId: "user_other",
      sharedWithOrg: true,
    });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [mine, shared],
      pins: [],
      actorUserId: USER_ID,
    });
    expect(result.errors[0]!.code).toBe("must_choose_connection");
    expect(result.errors[0]!.candidateConnections).toEqual(
      expect.arrayContaining([
        { id: mine.id, label: "web server", accountId: "root@web-01", ownedByActor: true },
        { id: shared.id, label: "database", accountId: "root@db-01", ownedByActor: false },
      ]),
    );
    // …and the snake_case projection the 412 envelope carries — the wire names
    // are what an API or MCP caller parses to pick without a second call.
    expect(translateResolutionError(result.errors[0]!)).toMatchObject({
      field: `integrations.${INTEG}`,
      code: "must_choose_connection",
      candidate_connections: expect.arrayContaining([
        { id: mine.id, label: "web server", account_id: "root@web-01", owned_by_actor: true },
        { id: shared.id, label: "database", account_id: "root@db-01", owned_by_actor: false },
      ]),
    });
  });

  it("must_choose candidates relay each row's label verbatim", () => {
    const a = conn({ accountId: "acc_a", label: "Boulot" });
    const b = conn({ authKey: "pat", accountId: "acc_b", label: "Perso" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [a, b],
      pins: [],
      actorUserId: USER_ID,
    });
    expect(result.errors[0]!.candidateConnections?.map((c) => c.label)).toEqual([
      "Boulot",
      "Perso",
    ]);
  });

  it("auto-resolves the single HEALTHY candidate even when a dead sibling exists", () => {
    const dead = conn({ needsReconnection: true });
    const healthy = conn({ authKey: "pat" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [dead, healthy],
      pins: [],
    });
    expect(result.errors).toHaveLength(0);
    expect(result.resolved[INTEG]![0]!.connectionId).toBe(healthy.id);
    expect(result.resolved[INTEG]![0]!.source).toBe("fallback_auto");
  });

  it("must_choose lists only LIVE candidates (flagged ones excluded from the picker)", () => {
    const a = conn({});
    const b = conn({ authKey: "pat" });
    const dead = conn({ authKey: "extra", needsReconnection: true });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [a, b, dead],
      pins: [],
    });
    expect(result.errors[0]!.code).toBe("must_choose_connection");
    const ids = result.errors[0]!.candidateConnections!.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(ids).not.toContain(dead.id);
  });

  it("emits needs_reconnection when EVERY candidate is flagged", () => {
    const d1 = conn({ needsReconnection: true });
    const d2 = conn({ authKey: "pat", needsReconnection: true });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [d1, d2],
      pins: [],
    });
    expect(result.errors[0]!.code).toBe("needs_reconnection");
    expect([d1.id, d2.id]).toContain(result.errors[0]!.connectionId!);
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
    expect(result.resolved[INTEG]![0]!.connectionId).toBe(c1.id);
    expect(result.resolved[INTEG2]![0]!.connectionId).toBe(c2.id);
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

  it("blocks an inert integration whose manifest declares a required auth (no connection)", () => {
    const result = resolveConnections({
      requirements: [
        {
          integrationId: INTEG,
          manifest: requiredOauth2Manifest(),
          hasSelectedTools: false,
          hasRequiredAuth: true,
          agentTools: [],
          agentScopes: [],
        },
      ],
      accessibleConnections: [],
      pins: [],
    });
    expect(result.resolved).toEqual({});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ integrationId: INTEG, code: "not_connected" });
  });

  it("auto-resolves an inert required-auth integration when one healthy connection exists", () => {
    const c = conn({});
    const result = resolveConnections({
      requirements: [
        {
          integrationId: INTEG,
          manifest: requiredOauth2Manifest(),
          hasSelectedTools: false,
          hasRequiredAuth: true,
          agentTools: [],
          agentScopes: [],
        },
      ],
      accessibleConnections: [c],
      pins: [],
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]).toMatchObject([{ connectionId: c.id }]);
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
    expect(result.resolved[INTEG]?.[0]?.connectionId).toBe(c.id);
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
  const ENFORCE = (...ids: string[]) => ({ [INTEG]: { connectionIds: ids, enforce: true } });
  const SOFT = (...ids: string[]) => ({ [INTEG]: { connectionIds: ids, enforce: false } });

  it("ENFORCE default wins over run override, schedule override, and member pin", () => {
    const def = conn({ sharedWithOrg: true });
    const other = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [def, other],
      pins: [memberPin(other.id)],
      runOverrides: { [INTEG]: [other.id] },
      scheduleOverrides: { [INTEG]: [other.id] },
      orgDefaults: ENFORCE(def.id),
      actorUserId: USER_ID,
    });
    expect(result.resolved[INTEG]).toEqual([
      {
        connectionId: def.id,
        source: "org_default_enforced",
        label: def.label,
        accountId: "acc_x",
      },
    ]);
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
    expect(result.resolved[INTEG]![0]!.source).toBe("admin_pin");
    expect(result.resolved[INTEG]![0]!.connectionId).toBe(pinned.id);
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
    expect(result.resolved[INTEG]).toEqual([
      {
        connectionId: def.id,
        source: "org_default",
        label: def.label,
        accountId: "acc_x",
      },
    ]);
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
    expect(result.resolved[INTEG]![0]!.source).toBe("member_pin");
    expect(result.resolved[INTEG]![0]!.connectionId).toBe(mine.id);
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
    expect(result.resolved[INTEG]).toEqual([
      {
        connectionId: onlyOne.id,
        source: "fallback_auto",
        label: onlyOne.label,
        accountId: "acc_x",
      },
    ]);
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
    expect(result.resolved[INTEG]![0]!.connectionId).toBe(patConn.id);
    expect(result.resolved[INTEG]![0]!.source).toBe("fallback_auto");
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
    expect(result.errors[0]!.candidateConnections?.map((c) => c.id)).toEqual(
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

// ─────────────────── Orphaned-auth guard (version-bump auth rename) ─────────────
describe("resolveConnections — orphaned-auth guard", () => {
  it("drops a connection whose authKey is absent from the current manifest", () => {
    // Simulates a version bump that renamed the auth (e.g. `primary` → the
    // declared `oauth`/`pat`): the lingering `legacy_primary` row can never be
    // delivered, so it must NOT be auto-picked — the run reports not_connected.
    const orphan = conn({ authKey: "legacy_primary" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [orphan],
      pins: [],
    });
    expect(result.resolved[INTEG]).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe("not_connected");
  });

  it("keeps declared-auth connections, dropping only the orphaned one", () => {
    const live = conn({ authKey: "oauth" });
    const orphan = conn({ authKey: "legacy_primary" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [live, orphan],
      pins: [],
    });
    // Single live candidate → auto; the orphan never competes (no must_choose).
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]?.[0]?.connectionId).toBe(live.id);
  });
});

// ───────── Connect-flow relay: auth_key + requiredScopes (issue #1207) ────────

/**
 * A run that needs more scopes than the connection holds — or needs a
 * connection that doesn't exist yet, or one whose credentials died — can only
 * be repaired by a connect flow, and the connect kickoff computes no scopes of
 * its own: `body.scopes` is the only delta it accepts. So the resolution error
 * has to name BOTH the auth to target and the full scope set that consent must
 * cover, for the three codes a connect flow can clear (`not_connected`,
 * `needs_reconnection`, `insufficient_scopes`).
 */
describe("resolveConnections — connect-flow relay (auth_key + requiredScopes)", () => {
  /**
   * `t1` needs `repo`, `t2` needs `admin:repo` (which implies `repo`), and
   * `user` is only reachable as an explicitly-selected agent scope.
   */
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
          scope_catalog: [
            { value: "admin:repo", label: "Admin repo", implies: ["repo"] },
            { value: "repo", label: "Repo" },
            { value: "user", label: "User" },
          ],
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
      tools_policy: {
        t1: { required_scopes: { oauth: ["repo"] } },
        t2: { required_scopes: { oauth: ["admin:repo"] } },
      },
    } as unknown as IntegrationManifest;
  }

  /** Two oauth2 auths — the resolver must refuse to guess between them. */
  function twoOauthManifest(): IntegrationManifest {
    const m = scopedManifest() as unknown as { auths: Record<string, unknown> };
    m.auths.oauth_alt = structuredClone(m.auths.oauth);
    return m as unknown as IntegrationManifest;
  }

  /** No oauth2 auth at all — a connect flow here carries no scopes. */
  function apiKeyOnlyManifest(): IntegrationManifest {
    return {
      type: "integration",
      schema_version: "0.1",
      name: INTEG,
      version: "1.0.0",
      display_name: "Test",
      source: { kind: "local", server: { name: "@vendor/test-server", version: "^1.0.0" } },
      auths: {
        pat: {
          type: "api_key",
          authorized_uris: ["https://api.example.com/**"],
          delivery: {
            http: {
              in: "header",
              name: "Authorization",
              prefix: "Bearer ",
              value: "{$credential.api_key}",
            },
          },
        },
      },
      tools_policy: { t1: { required_scopes: { pat: ["repo"] } } },
    } as unknown as IntegrationManifest;
  }

  /** An integration that declares NO auth at all — the zero-auth manifest the
   * orphaned-auth guard cannot constrain. */
  function noAuthManifest(): IntegrationManifest {
    return {
      type: "integration",
      schema_version: "0.1",
      name: INTEG,
      version: "1.0.0",
      display_name: "Test",
      source: { kind: "local", server: { name: "@vendor/test-server", version: "^1.0.0" } },
      auths: {},
      tools_policy: { t1: {} },
    } as unknown as IntegrationManifest;
  }

  function reqPinned(manifest: IntegrationManifest, authKey: string): IntegrationRequirement {
    return {
      integrationId: INTEG,
      manifest,
      hasSelectedTools: true,
      agentTools: ["t1", "t2"],
      agentScopes: ["user"],
      requiredAuthKey: authKey,
    };
  }

  it("insufficient_scopes carries the connection's auth_key and the FULL required set", () => {
    // `admin:repo` implies `repo`, so only the explicitly-selected `user` is
    // missing — but the consent must still request everything the run needs.
    const c = conn({ authKey: "oauth", scopesGranted: ["admin:repo"] });
    const result = resolveConnections({
      requirements: [req(scopedManifest(), ["t1", "t2"], ["user"])],
      accessibleConnections: [c],
      pins: [],
      actorUserId: USER_ID,
    });
    const err = result.errors[0]!;
    expect(err.code).toBe("insufficient_scopes");
    expect(err.authKey).toBe("oauth");
    expect(err.requiredScopes).toEqual(["repo", "admin:repo", "user"]);
    expect(err.missingScopes).toEqual(["user"]);
    // …and the snake_case projection the 412 envelope carries. `owned_by_actor`
    // is what the connect-offer mint gates on: a scope upgrade re-consents THIS
    // row, so minting for a foreign owner would re-consent someone else's
    // account.
    expect(translateResolutionError(err)).toMatchObject({
      field: `integrations.${INTEG}`,
      code: "insufficient_scopes",
      connection_id: c.id,
      auth_key: "oauth",
      required_scopes: ["repo", "admin:repo", "user"],
      missing_scopes: ["user"],
      owned_by_actor: true,
    });
  });

  it("not_connected resolves the auth_key from the agent dep's pin", () => {
    const result = resolveConnections({
      requirements: [reqPinned(scopedManifest(), "oauth")],
      accessibleConnections: [],
      pins: [],
      actorUserId: USER_ID,
    });
    const err = result.errors[0]!;
    expect(err.code).toBe("not_connected");
    expect(err.authKey).toBe("oauth");
    expect(err.requiredScopes).toEqual(["repo", "admin:repo", "user"]);
    // …and the snake_case projection, on real resolver output rather than a
    // hand-built error: the wire names are what the 412 consumers parse.
    expect(translateResolutionError(err)).toMatchObject({
      field: `integrations.${INTEG}`,
      code: "not_connected",
      auth_key: "oauth",
      required_scopes: ["repo", "admin:repo", "user"],
    });
  });

  it("not_connected falls back to the integration's SINGLE oauth2 auth when nothing is pinned", () => {
    const result = resolveConnections({
      requirements: [req(scopedManifest(), ["t1"], [])],
      accessibleConnections: [],
      pins: [],
      actorUserId: USER_ID,
    });
    const err = result.errors[0]!;
    expect(err.code).toBe("not_connected");
    expect(err.authKey).toBe("oauth");
    expect(err.requiredScopes).toEqual(["repo"]);
  });

  it("not_connected emits neither field with two oauth2 auths and no pin", () => {
    // Guessing would send the user through the wrong provider's consent.
    const result = resolveConnections({
      requirements: [req(twoOauthManifest(), ["t1"], [])],
      accessibleConnections: [],
      pins: [],
      actorUserId: USER_ID,
    });
    const err = result.errors[0]!;
    expect(err.code).toBe("not_connected");
    expect(err.authKey).toBeUndefined();
    expect(err.requiredScopes).toBeUndefined();
  });

  it("not_connected emits auth_key but omits requiredScopes when the selection needs no scopes", () => {
    const result = resolveConnections({
      requirements: [req(scopedManifest(), [], [])],
      accessibleConnections: [],
      pins: [],
      actorUserId: USER_ID,
      includeInert: true,
    });
    const err = result.errors[0]!;
    expect(err.code).toBe("not_connected");
    expect(err.authKey).toBe("oauth");
    expect(err.requiredScopes).toBeUndefined();
  });

  it("not_connected on an api_key-only integration emits neither field", () => {
    const result = resolveConnections({
      requirements: [req(apiKeyOnlyManifest(), ["t1"], [])],
      accessibleConnections: [],
      pins: [],
      actorUserId: USER_ID,
    });
    const err = result.errors[0]!;
    expect(err.code).toBe("not_connected");
    expect(err.authKey).toBeUndefined();
    expect(err.requiredScopes).toBeUndefined();
  });

  it("needs_reconnection carries the dead connection's auth_key and the full required set", () => {
    // A reconnect is a connect flow too: one consent that already covers the
    // selection, instead of reconnect → insufficient_scopes → upgrade.
    const c = conn({ authKey: "oauth", scopesGranted: ["repo"], needsReconnection: true });
    const result = resolveConnections({
      requirements: [req(scopedManifest(), ["t1", "t2"], ["user"])],
      accessibleConnections: [c],
      pins: [],
      actorUserId: USER_ID,
    });
    const err = result.errors[0]!;
    expect(err.code).toBe("needs_reconnection");
    expect(err.connectionId).toBe(c.id);
    expect(err.authKey).toBe("oauth");
    expect(err.requiredScopes).toEqual(["repo", "admin:repo", "user"]);
    expect(translateResolutionError(err)).toMatchObject({
      field: `integrations.${INTEG}`,
      code: "needs_reconnection",
      connection_id: c.id,
      auth_key: "oauth",
      required_scopes: ["repo", "admin:repo", "user"],
      // Same gate as insufficient_scopes: repairing the row in place is the
      // owner's to do, and the connect-offer mint reads this field.
      owned_by_actor: true,
    });
  });

  it("needs_reconnection on an api_key auth carries auth_key only", () => {
    const c = conn({ authKey: "pat", needsReconnection: true });
    const result = resolveConnections({
      requirements: [req(apiKeyOnlyManifest(), ["t1"], [])],
      accessibleConnections: [c],
      pins: [],
      actorUserId: USER_ID,
    });
    const err = result.errors[0]!;
    expect(err.code).toBe("needs_reconnection");
    expect(err.authKey).toBe("pat");
    // Omitted, not empty — the same shape the `not_connected` branch emits for
    // a scope-less auth, and the same absence on the wire either way.
    expect(err.requiredScopes).toBeUndefined();
    const field = translateResolutionError(err);
    expect(field).toMatchObject({ code: "needs_reconnection", auth_key: "pat" });
    expect(field).not.toHaveProperty("required_scopes");
  });

  it("a pin naming an auth the manifest dropped relays neither field", () => {
    // The pin is agent-side and the integration manifest moved under it. With
    // no connection at all the verdict is `not_connected` (auth_key_mismatch
    // needs an existing connection to mismatch), and echoing the stale pin
    // would name a connect target that cannot exist — `/auths/{key}/connect/…`
    // 404s. Neither field means "let the user choose", which is the truth here.
    const result = resolveConnections({
      requirements: [reqPinned(scopedManifest(), "retired_auth")],
      accessibleConnections: [],
      pins: [],
      actorUserId: USER_ID,
    });
    const err = result.errors[0]!;
    expect(err.code).toBe("not_connected");
    expect(err.authKey).toBeUndefined();
    expect(err.requiredScopes).toBeUndefined();
    const field = translateResolutionError(err);
    expect(field).not.toHaveProperty("auth_key");
    expect(field).not.toHaveProperty("required_scopes");
  });

  it("needs_reconnection on a connection whose auth the manifest dropped relays neither field", () => {
    // Same staleness rule as the pin above, one layer down: the relayed key
    // here comes from the connection ROW. The orphaned-auth guard normally
    // drops such rows, but it treats a zero-auth manifest as "no constraint"
    // (`manifestAuthKeySet` → null), so the row still reaches the health check.
    // Relaying its key would name a connect target `/auths/{key}/connect/…`
    // that 404s.
    const c = conn({ authKey: "oauth", needsReconnection: true });
    const result = resolveConnections({
      requirements: [req(noAuthManifest(), ["t1"], [])],
      accessibleConnections: [c],
      pins: [],
      actorUserId: USER_ID,
    });
    const err = result.errors[0]!;
    expect(err.code).toBe("needs_reconnection");
    expect(err.connectionId).toBe(c.id);
    expect(err.authKey).toBeUndefined();
    expect(err.requiredScopes).toBeUndefined();
    const field = translateResolutionError(err);
    expect(field).not.toHaveProperty("auth_key");
    expect(field).not.toHaveProperty("required_scopes");
  });

  it("a pinned non-oauth2 auth names the auth but carries no scopes", () => {
    const result = resolveConnections({
      requirements: [reqPinned(apiKeyOnlyManifest(), "pat")],
      accessibleConnections: [],
      pins: [],
      actorUserId: USER_ID,
    });
    const err = result.errors[0]!;
    expect(err.code).toBe("not_connected");
    expect(err.authKey).toBe("pat");
    expect(err.requiredScopes).toBeUndefined();
  });
});

// ─────────────────────── Connection SETS (1..N per integration) ───────────────

/**
 * Every cascade layer binds a SET. Each case below pairs the N>1 behaviour
 * with its N=1 control, because the single-connection shape is what the whole
 * platform degenerates to and must stay untouched.
 */
describe("resolveConnections — connection sets", () => {
  it("binds the whole admin-pin set, every member carrying the same source", () => {
    const web = conn({ label: "web-1" });
    const dbx = conn({ authKey: "pat", label: "db" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [web, dbx],
      pins: [pin([web.id, dbx.id])],
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]).toEqual([
      { connectionId: web.id, source: "admin_pin", label: "web-1", accountId: "acc_x" },
      { connectionId: dbx.id, source: "admin_pin", label: "db", accountId: "acc_x" },
    ]);
  });

  it("control — a one-member admin pin still resolves to a one-element set", () => {
    const only = conn({ label: "web-1" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [only],
      pins: [pin(only.id)],
    });
    expect(result.resolved[INTEG]).toEqual([
      { connectionId: only.id, source: "admin_pin", label: "web-1", accountId: "acc_x" },
    ]);
  });

  it("run override binds N connections", () => {
    const a = conn({ label: "web-1" });
    const b = conn({ authKey: "pat", label: "db" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [a, b],
      pins: [],
      runOverrides: { [INTEG]: [a.id, b.id] },
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]!.map((r) => r.connectionId)).toEqual([a.id, b.id]);
    expect(result.resolved[INTEG]!.every((r) => r.source === "run_override")).toBe(true);
  });

  it("an admin pin of 2 beats a run override of 1", () => {
    const pinnedA = conn({ label: "web-1" });
    const pinnedB = conn({ authKey: "pat", label: "db" });
    const overridden = conn({ label: "other" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [pinnedA, pinnedB, overridden],
      pins: [pin([pinnedA.id, pinnedB.id])],
      runOverrides: { [INTEG]: [overridden.id] },
    });
    expect(result.resolved[INTEG]!.map((r) => r.connectionId)).toEqual([pinnedA.id, pinnedB.id]);
  });

  it("an ENFORCE org default of 2 beats a run override of 1", () => {
    const defA = conn({ label: "web-1", sharedWithOrg: true });
    const defB = conn({ authKey: "pat", label: "db", sharedWithOrg: true });
    const overridden = conn({ label: "other" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [defA, defB, overridden],
      pins: [],
      orgDefaults: { [INTEG]: { connectionIds: [defA.id, defB.id], enforce: true } },
      runOverrides: { [INTEG]: [overridden.id] },
    });
    expect(result.resolved[INTEG]!.map((r) => r.connectionId)).toEqual([defA.id, defB.id]);
    expect(result.resolved[INTEG]![0]!.source).toBe("org_default_enforced");
  });

  it("names the offending id when ONE member of a pinned set is gone", () => {
    const live = conn({ label: "web-1" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [live],
      pins: [pin([live.id, "conn_ghost"])],
    });
    expect(result.resolved[INTEG]).toBeUndefined();
    expect(result.errors[0]!.code).toBe("pinned_connection_unavailable");
    expect(result.errors[0]!.message).toContain("conn_ghost");
    expect(result.errors[0]!.message).toContain("may have been deleted");
  });

  it("a gone member of a MEMBER pin fails loud too — the survivor is not bound alone", () => {
    const live = conn({ label: "web-1" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [live],
      pins: [memberPin([live.id, "conn_ghost"])],
      actorUserId: USER_ID,
    });
    expect(result.resolved[INTEG]).toBeUndefined();
    expect(result.errors[0]!.code).toBe("pinned_connection_unavailable");
    expect(result.errors[0]!.message).toContain("conn_ghost");
  });

  it("an ENFORCE default with a gone member fails loud, naming it", () => {
    const live = conn({ label: "web-1", sharedWithOrg: true });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [live],
      pins: [],
      orgDefaults: { [INTEG]: { connectionIds: [live.id, "conn_ghost"], enforce: true } },
    });
    expect(result.resolved[INTEG]).toBeUndefined();
    expect(result.errors[0]!.code).toBe("pinned_connection_unavailable");
    expect(result.errors[0]!.message).toContain("conn_ghost");
    expect(result.errors[0]!.message).toContain("may have been deleted");
  });

  it("a dead member fails the whole set with needs_reconnection naming it", () => {
    const live = conn({ label: "web-1" });
    const dead = conn({ authKey: "pat", label: "db", needsReconnection: true });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [live, dead],
      pins: [pin([live.id, dead.id])],
    });
    expect(result.resolved[INTEG]).toBeUndefined();
    expect(result.errors[0]!.code).toBe("needs_reconnection");
    expect(result.errors[0]!.connectionId).toBe(dead.id);
    expect(result.errors[0]!.boundConnectionIds).toEqual([live.id, dead.id]);
  });

  it("an under-scoped member reports the WHOLE bound set, not just itself", () => {
    const scoped = {
      ...oauth2Manifest(),
      tools_policy: { t1: { required_scopes: { oauth: ["repo"] } } },
    } as unknown as IntegrationManifest;
    const ok = conn({ label: "web-1", scopesGranted: ["repo"] });
    const short = conn({ label: "web-2", scopesGranted: [] });
    const result = resolveConnections({
      requirements: [req(scoped, ["t1"])],
      accessibleConnections: [ok, short],
      pins: [pin([ok.id, short.id])],
    });
    const err = result.errors[0]!;
    expect(err.code).toBe("insufficient_scopes");
    expect(err.connectionId).toBe(short.id);
    expect(err.boundConnectionIds).toEqual([ok.id, short.id]);
  });

  it("control — the healthy sibling alone still resolves", () => {
    const live = conn({ label: "web-1" });
    const dead = conn({ authKey: "pat", label: "db", needsReconnection: true });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [live, dead],
      pins: [pin(live.id)],
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]!.map((r) => r.connectionId)).toEqual([live.id]);
  });
});

/**
 * Plan §8 row 3 — the label is the agent's handle for a connection (the
 * sidecar's injected `connection` enum), so a bound set whose labels collide
 * is unaddressable and must be refused before the run exists.
 */
describe("resolveConnections — duplicate_connection_label", () => {
  it("refuses a bound set whose members share a label, listing the collision", () => {
    const a = conn({ label: "prod", accountId: "acc_a" });
    const b = conn({ authKey: "pat", label: "prod", accountId: "acc_b" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [a, b],
      pins: [],
      runOverrides: { [INTEG]: [a.id, b.id] },
      actorUserId: USER_ID,
    });
    expect(result.resolved[INTEG]).toBeUndefined();
    const err = result.errors[0]!;
    expect(err.code).toBe("duplicate_connection_label");
    expect(err.candidateConnections?.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(err.boundConnectionIds).toEqual([a.id, b.id]);
    expect(translateResolutionError(err)).toMatchObject({
      field: `integrations.${INTEG}`,
      code: "duplicate_connection_label",
      candidate_connections: [
        { id: a.id, label: "prod", account_id: "acc_a", owned_by_actor: true },
        { id: b.id, label: "prod", account_id: "acc_b", owned_by_actor: true },
      ],
    });
  });

  it("control — distinct labels resolve the same set", () => {
    const a = conn({ label: "prod" });
    const b = conn({ authKey: "pat", label: "staging" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [a, b],
      pins: [],
      runOverrides: { [INTEG]: [a.id, b.id] },
      actorUserId: USER_ID,
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]!.map((r) => r.connectionId)).toEqual([a.id, b.id]);
  });

  it("compares labels VERBATIM — a case difference is two distinct handles", () => {
    // The sidecar serves the labels as a string enum, so `Prod` and `prod` are
    // two addressable values. Folding case here would refuse a legal bind.
    const a = conn({ label: "Prod" });
    const b = conn({ authKey: "pat", label: "prod" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [a, b],
      pins: [],
      runOverrides: { [INTEG]: [a.id, b.id] },
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]!.map((r) => r.connectionId)).toEqual([a.id, b.id]);
  });

  it("collides only WITHIN one integration — the same label elsewhere is fine", () => {
    const INTEG2 = "@vendor/other-integ";
    const a = conn({ label: "prod" });
    const b = conn({ integrationId: INTEG2, label: "prod" });
    const m2 = { ...oauth2Manifest(), name: INTEG2 } as IntegrationManifest;
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
      accessibleConnections: [a, b],
      pins: [],
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]![0]!.connectionId).toBe(a.id);
    expect(result.resolved[INTEG2]![0]!.connectionId).toBe(b.id);
  });
});

/**
 * Plan §8 row 5 — the fallback is the ONE layer that binds without an
 * explicit pick, and it binds at most one. N accessible connections is a
 * choice for a human, never an auto-bound set.
 */
describe("resolveConnections — the fallback never auto-binds N", () => {
  it("two accessible connections and no pick ⇒ must_choose_connection, nothing bound", () => {
    const a = conn({ label: "web-1" });
    const b = conn({ authKey: "pat", label: "db" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [a, b],
      pins: [],
    });
    expect(result.resolved[INTEG]).toBeUndefined();
    expect(result.errors[0]!.code).toBe("must_choose_connection");
  });

  it("control — one accessible connection auto-binds", () => {
    const a = conn({ label: "web-1" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [a],
      pins: [],
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]).toHaveLength(1);
    expect(result.resolved[INTEG]![0]!.source).toBe("fallback_auto");
  });
});

/**
 * A multi-auth set binds one spec per member, and an `api_call` tool reaches the
 * agent only through its own auth's connection — so a member whose auth serves
 * none of the selected tools is refused here, not dropped at spawn.
 */
describe("resolveConnections — auth_serves_no_selected_tool", () => {
  function serverlessManifest(): IntegrationManifest {
    const m = oauth2Manifest() as unknown as Record<string, unknown>;
    m.source = { kind: "none" };
    m._meta = { "dev.appstrate/api": { auths: { oauth: {}, pat: {} } } };
    return m as unknown as IntegrationManifest;
  }
  function selecting(manifest: IntegrationManifest, tools: string[] | "*") {
    return { ...req(manifest), effectiveTools: tools };
  }

  it("refuses a pinned set whose second member's auth serves no selected tool", () => {
    const a = conn({ label: "main" });
    const b = conn({ authKey: "pat", label: "spare" });
    const result = resolveConnections({
      requirements: [selecting(serverlessManifest(), ["api_call__oauth"])],
      accessibleConnections: [a, b],
      pins: [pin([a.id, b.id])],
    });
    expect(result.resolved[INTEG]).toBeUndefined();
    const err = result.errors[0]!;
    expect(err.code).toBe("auth_serves_no_selected_tool");
    expect(err.connectionId).toBe(b.id);
    expect(err.boundConnectionIds).toEqual([a.id, b.id]);
    expect(translateResolutionError(err)).toMatchObject({
      code: "auth_serves_no_selected_tool",
      connection_id: b.id,
    });
  });

  it("control — a selection covering both auths binds the same set", () => {
    const a = conn({ label: "main" });
    const b = conn({ authKey: "pat", label: "spare" });
    const result = resolveConnections({
      requirements: [selecting(serverlessManifest(), ["api_call__oauth", "api_call__pat"])],
      accessibleConnections: [a, b],
      pins: [pin([a.id, b.id])],
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]!.map((r) => r.connectionId)).toEqual([a.id, b.id]);
  });

  it("does not apply when a server's own tools reach every connection", () => {
    const a = conn({ label: "main" });
    const b = conn({ authKey: "pat", label: "spare" });
    const local = oauth2Manifest() as unknown as Record<string, unknown>;
    local._meta = { "dev.appstrate/api": { auths: { oauth: {}, pat: {} } } };
    const result = resolveConnections({
      requirements: [
        selecting(local as unknown as IntegrationManifest, ["search", "api_call__oauth"]),
      ],
      accessibleConnections: [a, b],
      pins: [pin([a.id, b.id])],
    });
    expect(result.errors).toEqual([]);
  });

  it("fallback with only a non-serving connection is not_connected on a serving auth", () => {
    const b = conn({ authKey: "pat", label: "spare" });
    const result = resolveConnections({
      requirements: [selecting(serverlessManifest(), ["api_call__oauth"])],
      accessibleConnections: [b],
      pins: [],
      actorUserId: USER_ID,
    });
    const err = result.errors[0]!;
    expect(err.code).toBe("not_connected");
    expect(err.authKey).toBe("oauth");
    expect(connectOfferTarget(translateResolutionError(err))).toEqual({
      integrationId: INTEG,
      authKey: "oauth",
      scopes: [],
    });
  });

  it("names no connect target on an auth that serves none of the selection", () => {
    const result = resolveConnections({
      requirements: [selecting(serverlessManifest(), ["api_call__pat"])],
      accessibleConnections: [],
      pins: [],
      actorUserId: USER_ID,
    });
    const err = result.errors[0]!;
    expect(err.code).toBe("not_connected");
    expect(err.authKey).toBeUndefined();
  });

  it("refuses nothing when no auth serves the selection — not a connection problem", () => {
    const a = conn({ label: "main" });
    const result = resolveConnections({
      requirements: [selecting(serverlessManifest(), ["api_call__gone"])],
      accessibleConnections: [a],
      pins: [pin([a.id])],
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]!.map((r) => r.connectionId)).toEqual([a.id]);
  });

  it("fallback skips a non-serving candidate instead of asking to choose", () => {
    const a = conn({ label: "main" });
    const b = conn({ authKey: "pat", label: "spare" });
    const result = resolveConnections({
      requirements: [selecting(serverlessManifest(), ["api_call__oauth"])],
      accessibleConnections: [a, b],
      pins: [],
      actorUserId: USER_ID,
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]!.map((r) => r.connectionId)).toEqual([a.id]);
  });
});
