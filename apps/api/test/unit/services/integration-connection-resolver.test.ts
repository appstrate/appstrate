// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure `resolveConnections()` function — the
 * 4-mechanism cascade that decides which integration connection a run
 * uses per (integration, authKey).
 *
 * Pure function, no DB. All inputs are arrays + plain objects. The
 * orchestrator that fans out to DB lives in the same module but isn't
 * tested here (covered by integration tests in P2).
 *
 * Cascade order (highest → lowest):
 *   1. integration_pins                  → admin force
 *   2. runs.connection_overrides         → caller's run-time choice
 *   3. package_schedules.connection_overrides → schedule frozen
 *   4. fallback: own + shared accessible
 *      → 1 match = auto, 0 = not_connected, N = must_choose
 *
 * Each test asserts (a) the chosen connection.id (b) the resolution
 * source label, OR (a) the error code and (b) the structured detail.
 */

import { describe, it, expect } from "bun:test";
import {
  resolveConnections,
  type IntegrationRequirement,
} from "../../../src/services/integration-connection-resolver.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type { InferSelectModel } from "drizzle-orm";
import type { integrationConnections, integrationPins } from "@appstrate/db/schema";

type ConnectionRow = InferSelectModel<typeof integrationConnections>;
type PinRow = InferSelectModel<typeof integrationPins>;

// ─────────────────────────── Fixtures ─────────────────────────────────────────

const INTEG = "@vendor/test-integ";
const APP_ID = "app_test";
const USER_ID = "user_alice";
const AGENT_ID = "@vendor/test-agent";

function oauth2Manifest(overrides?: {
  availableScopes?: { value: string; implies?: string[] }[];
}): IntegrationManifest {
  return {
    manifestVersion: "1.0",
    type: "integration",
    name: INTEG,
    version: "1.0.0",
    displayName: "Test",
    server: { type: "node", entryPoint: "index.js" },
    auths: {
      oauth: {
        type: "oauth2",
        authorizationUrl: "https://idp/auth",
        tokenUrl: "https://idp/token",
        scopes: [],
        ...(overrides?.availableScopes ? { availableScopes: overrides.availableScopes } : {}),
      },
    },
    tools: {},
  } as unknown as IntegrationManifest;
}

function apiKeyManifest(): IntegrationManifest {
  return {
    manifestVersion: "1.0",
    type: "integration",
    name: INTEG,
    version: "1.0.0",
    displayName: "Test",
    server: { type: "node", entryPoint: "index.js" },
    auths: {
      api: { type: "api_key" },
    },
    tools: {},
  } as unknown as IntegrationManifest;
}

let connId = 0;
function conn(input: Partial<ConnectionRow> & { authKey?: string }): ConnectionRow {
  connId += 1;
  return {
    id: `conn_${connId}`,
    integrationPackageId: INTEG,
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
function pin(connectionId: string, authKey = "oauth", opts?: { userId?: string | null }): PinRow {
  pinSeq += 1;
  return {
    id: `pin_${pinSeq}`,
    applicationId: APP_ID,
    packageId: AGENT_ID,
    integrationPackageId: INTEG,
    authKey,
    userId: opts?.userId ?? null,
    connectionId,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Sugar — member pin scoped to the test's default user. */
function memberPin(connectionId: string, authKey = "oauth"): PinRow {
  return pin(connectionId, authKey, { userId: USER_ID });
}

function req(
  manifest: IntegrationManifest,
  opts?: { requiredAuthKeys?: string[]; requiredScopes?: Record<string, string[]> },
): IntegrationRequirement {
  return {
    integrationId: INTEG,
    manifest,
    requiredAuthKeys: opts?.requiredAuthKeys ?? ["oauth"],
    requiredScopesByAuth: opts?.requiredScopes ?? {},
  };
}

// ─────────────────────────── Cascade tests ────────────────────────────────────

describe("resolveConnections — pin (cascade layer 1)", () => {
  it("uses the pinned connection when present and accessible", () => {
    const c = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [pin(c.id)],
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]!.oauth).toEqual({
      connectionId: c.id,
      source: "admin_pin",
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
      runOverrides: { [INTEG]: { oauth: overridden.id } },
    });
    expect(result.resolved[INTEG]!.oauth!.connectionId).toBe(pinned.id);
    expect(result.resolved[INTEG]!.oauth!.source).toBe("admin_pin");
  });

  it("pin wins over schedule override", () => {
    const pinned = conn({});
    const sched = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [pinned, sched],
      pins: [pin(pinned.id)],
      scheduleOverrides: { [INTEG]: { oauth: sched.id } },
    });
    expect(result.resolved[INTEG]!.oauth!.source).toBe("admin_pin");
  });
});

describe("resolveConnections — run override (cascade layer 2)", () => {
  it("uses run override when no pin", () => {
    const c = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [],
      runOverrides: { [INTEG]: { oauth: c.id } },
    });
    expect(result.resolved[INTEG]!.oauth).toEqual({
      connectionId: c.id,
      source: "run_override",
    });
  });

  it("run override wins over schedule override", () => {
    const runChoice = conn({});
    const sched = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [runChoice, sched],
      pins: [],
      runOverrides: { [INTEG]: { oauth: runChoice.id } },
      scheduleOverrides: { [INTEG]: { oauth: sched.id } },
    });
    expect(result.resolved[INTEG]!.oauth!.source).toBe("run_override");
  });

  it("emits override_connection_unavailable when the override points nowhere", () => {
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [],
      pins: [],
      runOverrides: { [INTEG]: { oauth: "conn_ghost" } },
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
      scheduleOverrides: { [INTEG]: { oauth: c.id } },
    });
    expect(result.resolved[INTEG]!.oauth!.source).toBe("schedule_override");
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
    expect(result.resolved[INTEG]!.oauth).toEqual({
      connectionId: c.id,
      source: "member_pin",
    });
  });

  it("member pin scoped to OTHER actor is ignored — falls through to fallback", () => {
    const c = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [pin(c.id, "oauth", { userId: "user_someone_else" })],
      actorUserId: USER_ID,
    });
    expect(result.resolved[INTEG]!.oauth!.source).toBe("fallback_auto");
  });

  it("admin pin wins over member pin (same agent, same auth)", () => {
    const adminChoice = conn({});
    const memberChoice = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [adminChoice, memberChoice],
      pins: [pin(adminChoice.id), memberPin(memberChoice.id)],
      actorUserId: USER_ID,
    });
    expect(result.resolved[INTEG]!.oauth!.connectionId).toBe(adminChoice.id);
    expect(result.resolved[INTEG]!.oauth!.source).toBe("admin_pin");
  });

  it("run override wins over member pin", () => {
    const memberChoice = conn({});
    const runChoice = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [memberChoice, runChoice],
      pins: [memberPin(memberChoice.id)],
      runOverrides: { [INTEG]: { oauth: runChoice.id } },
      actorUserId: USER_ID,
    });
    expect(result.resolved[INTEG]!.oauth!.source).toBe("run_override");
  });

  it("member pin wins over the >1 fallback ambiguity", () => {
    // Without the pin, the 2 candidates would surface must_choose. The
    // pin disambiguates — that's its entire point.
    const picked = conn({});
    const other = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [picked, other],
      pins: [memberPin(picked.id)],
      actorUserId: USER_ID,
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]!.oauth!.connectionId).toBe(picked.id);
    expect(result.resolved[INTEG]!.oauth!.source).toBe("member_pin");
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
    // No admin pin, no overrides, no member-pin-applicable → fallback auto.
    expect(result.resolved[INTEG]!.oauth!.source).toBe("fallback_auto");
  });
});

describe("resolveConnections — fallback (cascade layer 4)", () => {
  it("auto-picks the single accessible connection", () => {
    const c = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [],
    });
    expect(result.resolved[INTEG]!.oauth).toEqual({
      connectionId: c.id,
      source: "fallback_auto",
    });
  });

  it("includes shared connections in the candidate set", () => {
    const adminShared = conn({ userId: "user_admin", sharedWithOrg: true });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [adminShared],
      pins: [],
    });
    expect(result.resolved[INTEG]!.oauth!.connectionId).toBe(adminShared.id);
    expect(result.resolved[INTEG]!.oauth!.source).toBe("fallback_auto");
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
    expect(result.errors[0]!.authKey).toBe("oauth");
  });

  it("emits must_choose_connection when >1 candidate", () => {
    const a = conn({});
    const b = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [a, b],
      pins: [],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe("must_choose_connection");
    expect(result.errors[0]!.candidateConnectionIds).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it("filters candidates by integrationId + authKey", () => {
    // Connection matches integration but wrong auth — not a candidate.
    const wrongAuth = conn({ authKey: "other" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [wrongAuth],
      pins: [],
    });
    expect(result.errors[0]!.code).toBe("not_connected");
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
  });

  it("needs_reconnection fires for pinned + override paths too", () => {
    const c = conn({ needsReconnection: true });
    const pinResult = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [pin(c.id)],
    });
    expect(pinResult.errors[0]!.code).toBe("needs_reconnection");
  });

  it("emits insufficient_scopes when granted does not cover required", () => {
    const c = conn({ scopesGranted: ["read"] });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest(), { requiredScopes: { oauth: ["read", "write"] } })],
      accessibleConnections: [c],
      pins: [],
    });
    expect(result.errors[0]!.code).toBe("insufficient_scopes");
    expect(result.errors[0]!.requiredScopes).toEqual(["read", "write"]);
    expect(result.errors[0]!.grantedScopes).toEqual(["read"]);
  });

  it("expands granted scopes through implies hierarchy", () => {
    // `admin` implies `read` + `write`. Connection granted `admin` covers both.
    const m = oauth2Manifest({
      availableScopes: [
        { value: "admin", implies: ["read", "write"] },
        { value: "read" },
        { value: "write" },
      ],
    });
    const c = conn({ scopesGranted: ["admin"] });
    const result = resolveConnections({
      requirements: [req(m, { requiredScopes: { oauth: ["read", "write"] } })],
      accessibleConnections: [c],
      pins: [],
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]!.oauth!.connectionId).toBe(c.id);
  });

  it("skips scope check for api_key auths (opaque grants)", () => {
    const c = conn({ authKey: "api", scopesGranted: [] });
    const result = resolveConnections({
      requirements: [
        req(apiKeyManifest(), {
          requiredAuthKeys: ["api"],
          requiredScopes: { api: ["read"] },
        }),
      ],
      accessibleConnections: [c],
      pins: [],
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]!.api!.connectionId).toBe(c.id);
  });
});

describe("resolveConnections — multi-integration, multi-auth", () => {
  it("handles each (integration, authKey) independently", () => {
    const INTEG2 = "@vendor/other-integ";
    const c1 = conn({});
    const c2 = conn({ integrationPackageId: INTEG2 });
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
          requiredAuthKeys: ["oauth"],
          requiredScopesByAuth: {},
        },
      ],
      accessibleConnections: [c1, c2],
      pins: [],
    });
    expect(result.resolved[INTEG]!.oauth!.connectionId).toBe(c1.id);
    expect(result.resolved[INTEG2]!.oauth!.connectionId).toBe(c2.id);
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
          requiredAuthKeys: ["oauth"],
          requiredScopesByAuth: {},
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

describe("resolveConnections — empty requirements / inert auth keys", () => {
  it("returns empty result when no requirements", () => {
    const result = resolveConnections({
      requirements: [],
      accessibleConnections: [],
      pins: [],
    });
    expect(result.resolved).toEqual({});
    expect(result.errors).toEqual([]);
  });

  it("skips integrations with no required auth keys (agent picked 0 tools)", () => {
    const result = resolveConnections({
      requirements: [req(oauth2Manifest(), { requiredAuthKeys: [] })],
      accessibleConnections: [],
      pins: [],
    });
    expect(result.resolved).toEqual({});
    expect(result.errors).toEqual([]);
  });
});
