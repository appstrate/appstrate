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
 *   3. launch override                           → the run's or the schedule's picks
 *   4. integration_pins (user_id = actor.id)     → member preference
 *   5. integration_org_defaults (soft)           → org-wide default (binds whole or fails, like 1-4)
 *   6. fallback: own + shared accessible
 *      → exactly one OWN = auto, two or more = must_choose (one known account:
 *        the least-privileged that covers the agent); no own row =
 *        not_connected / must_choose when `required`, else bound to none + warning
 *
 * A layer set to `[]` is "none": it wins, binding none (or failing when `required`).
 * An integration switched off in the space is not resolved (a warning, or an error when `required`).
 */

import { describe, it, expect } from "bun:test";
import {
  resolveConnections as resolveConnectionsPure,
  servingCandidates,
  translateResolutionError,
  type IntegrationRequirement,
} from "../../../src/services/integration-connection-resolver.ts";
import { connectOfferTarget } from "../../../src/services/connect/preflight-connect-offer.ts";
import {
  CONNECTION_RESOLUTION_WARNING_CODES,
  type ConnectionResolutionSource,
  type ConnectionResolutionWarningCode,
  type IntegrationManifest,
} from "@appstrate/core/integration";
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

/** Sugar — the launch-override layer, as a run and as a schedule fire feed it. */
const runOverride = (ids: Record<string, string[]>) => ({
  ids,
  source: "run_override" as const,
});
const scheduleOverride = (ids: Record<string, string[]>) => ({
  ids,
  source: "schedule_override" as const,
});

/** Sugar — member pin scoped to the test's default user. */
function memberPin(connectionIds: string | string[]): PinRow {
  return pin(connectionIds, { userId: USER_ID });
}

/**
 * Every case acts as `USER_ID` unless it says otherwise (`actorUserId: null`):
 * the fallback binds only the actor's OWN connection, so an actor-less call
 * would turn every single-candidate case into `must_choose_connection`.
 */
function resolveConnections(input: Parameters<typeof resolveConnectionsPure>[0]) {
  return resolveConnectionsPure({ actorUserId: USER_ID, ...input });
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
    required: false,
  };
}

/** {@link req} for an agent that marks the integration `required`: no run without it. */
function requiredReq(...args: Parameters<typeof req>): IntegrationRequirement {
  return { ...req(...args), required: true };
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
    expect(result.errors[0]!.source).toBe("admin_pin");
    expect(result.errors[0]!.message).toContain("may have been deleted");
  });

  it("refuses a run override outside the pin with override_outranked", () => {
    const pinned = conn({});
    const overridden = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [pinned, overridden],
      pins: [pin(pinned.id)],
      launchOverrides: runOverride({ [INTEG]: [overridden.id] }),
    });
    expect(result.resolved[INTEG]).toBeUndefined();
    expect(result.errors[0]!.code).toBe("override_outranked");
    expect(result.errors[0]!.source).toBe("run_override");
    expect(result.errors[0]!.message).toContain("an admin pin");
    expect(translateResolutionError(result.errors[0]!).title).toBe(
      "Override Outranked By Governance",
    );
  });

  it("refuses a schedule override that only PARTLY overlaps the pin", () => {
    const pinned = conn({});
    const sched = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [pinned, sched],
      pins: [pin(pinned.id)],
      launchOverrides: scheduleOverride({ [INTEG]: [pinned.id, sched.id] }),
    });
    expect(result.errors[0]!.code).toBe("override_outranked");
    expect(result.errors[0]!.source).toBe("schedule_override");
  });

  it("an override naming a subset of the pin binds exactly that subset", () => {
    const a = conn({});
    const b = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [a, b],
      pins: [pin([a.id, b.id])],
      launchOverrides: runOverride({ [INTEG]: [b.id] }),
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]!.map((r) => [r.connectionId, r.source])).toEqual([
      [b.id, "run_override"],
    ]);
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

describe("resolveConnections — launch override (cascade layer 3)", () => {
  it("emits override_connection_unavailable when the override points nowhere, naming its layer", () => {
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [],
      pins: [],
      launchOverrides: runOverride({ [INTEG]: ["conn_ghost"] }),
    });
    expect(result.errors[0]!.code).toBe("override_connection_unavailable");
    expect(result.errors[0]!.source).toBe("run_override");
    expect(result.errors[0]!.message).toContain("Run-override connection");
  });

  it("a schedule fire's unreachable pick names the schedule layer", () => {
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [],
      pins: [],
      launchOverrides: scheduleOverride({ [INTEG]: ["conn_ghost"] }),
    });
    expect(result.errors[0]!.code).toBe("override_connection_unavailable");
    expect(result.errors[0]!.source).toBe("schedule_override");
    expect(result.errors[0]!.message).toContain("Schedule-override connection");
  });

  it("an override naming another integration only is no opinion for this one", () => {
    const c = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [],
      launchOverrides: runOverride({ "@vendor/other": [c.id] }),
    });
    expect(result.resolved[INTEG]![0]!.source).toBe("fallback_auto");
  });

  it("a scheduled fire binds with source schedule_override", () => {
    const c = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [],
      launchOverrides: scheduleOverride({ [INTEG]: [c.id] }),
    });
    expect(result.resolved[INTEG]![0]!.source).toBe("schedule_override");
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
      launchOverrides: runOverride({ [INTEG]: [runChoice.id] }),
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
    expect(result.errors[0]!.source).toBe("member_pin");
  });

  it("end-user run (actorUserId=null) ignores all member pins", () => {
    const c = conn({ userId: null, endUserId: "eu_1" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [memberPin(c.id)],
      actorUserId: null,
      actorEndUserId: "eu_1",
    });
    expect(result.resolved[INTEG]![0]!.source).toBe("fallback_auto");
  });
});

describe("resolveConnections — fallback (cascade layer 6)", () => {
  const COLLEAGUE = "user_colleague";
  const END_USER = "eu_1";
  const own = (over: Partial<ConnectionRow> = {}) => conn(over);
  const shared = (over: Partial<ConnectionRow> = {}) =>
    conn({ userId: COLLEAGUE, sharedWithOrg: true, ...over });
  const DEAD = { needsReconnection: true };

  /**
   * Bind `rows[bind]`, raise `error` — on `rows[on]` when the error names a connection — or
   * bind none with a warning offering `rows[unbound]`, coded as the required verdict's error.
   */
  type Verdict =
    | { bind: number }
    | { error: "not_connected" | "must_choose_connection" | "needs_reconnection"; on?: number }
    | { unbound: number[] };

  /** `verdict` holds for a required integration; `optional`, when set, for a non-required one. */
  const cases: {
    name: string;
    rows: () => ConnectionRow[];
    verdict: Verdict;
    optional?: Verdict;
  }[] = [
    {
      name: "own 0, shared 0",
      rows: () => [],
      verdict: { error: "not_connected" },
      optional: { unbound: [] },
    },
    {
      name: "own 0, shared 1 (a colleague's account is never picked for you)",
      rows: () => [shared()],
      verdict: { error: "must_choose_connection" },
      optional: { unbound: [0] },
    },
    {
      name: "own 0, shared 2",
      rows: () => [shared(), shared({ authKey: "pat" })],
      verdict: { error: "must_choose_connection" },
      optional: { unbound: [0, 1] },
    },
    { name: "own 1", rows: () => [own()], verdict: { bind: 0 } },
    { name: "own 1 + shared 1 (the own one)", rows: () => [shared(), own()], verdict: { bind: 1 } },
    {
      name: "own 1 dead",
      rows: () => [own(DEAD)],
      verdict: { error: "needs_reconnection", on: 0 },
    },
    {
      name: "own 1 dead + shared 1 live (no switch)",
      rows: () => [shared(), own(DEAD)],
      verdict: { error: "needs_reconnection", on: 1 },
    },
    {
      name: "own 2 (any auth shape)",
      rows: () => [own(), own({ authKey: "pat" })],
      verdict: { error: "must_choose_connection" },
    },
    {
      name: "own 2, one dead (the dead one counts)",
      rows: () => [own(DEAD), own({ authKey: "pat" })],
      verdict: { error: "must_choose_connection" },
    },
    {
      name: "own 2, both dead",
      rows: () => [own(DEAD), own({ authKey: "pat", ...DEAD })],
      verdict: { error: "must_choose_connection" },
    },
  ];

  const outcome = (v: Verdict) =>
    "bind" in v ? "binds it" : "error" in v ? v.error : "binds none + its warning";

  for (const { name, rows: build, verdict: requiredVerdict, optional } of cases) {
    for (const required of [true, false]) {
      const verdict = required ? requiredVerdict : (optional ?? requiredVerdict);
      it(`${required ? "required" : "non-required"}: ${name} → ${outcome(verdict)}`, () => {
        const rows = build();
        const result = resolveConnections({
          requirements: [{ ...req(oauth2Manifest()), required }],
          accessibleConnections: rows,
          pins: [],
        });
        if ("bind" in verdict) {
          const bound = rows[verdict.bind]!;
          expect(result.errors).toEqual([]);
          expect(result.warnings).toEqual([]);
          expect(result.resolved[INTEG]).toEqual([
            {
              connectionId: bound.id,
              source: "fallback_auto",
              label: bound.label,
              accountId: "acc_x",
            },
          ]);
        } else if ("unbound" in verdict) {
          expect(result.errors).toEqual([]);
          expect(result.resolved[INTEG]).toEqual([]);
          expect(result.warnings).toHaveLength(1);
          const warning = result.warnings[0]!;
          // The code the same state raises on a required integration; no layer chose it.
          const twin = "error" in requiredVerdict ? requiredVerdict.error : undefined;
          expect(warning).toMatchObject({ integrationId: INTEG, code: twin });
          expect(warning.source).toBeUndefined();
          // A shared row is offered, never bound.
          expect(warning.candidateConnections?.map((c) => c.id)).toEqual(
            verdict.unbound.length > 0 ? verdict.unbound.map((i) => rows[i]!.id) : undefined,
          );
        } else {
          expect(result.resolved[INTEG]).toBeUndefined();
          expect(result.warnings).toEqual([]);
          expect(result.errors.map((e) => e.code)).toEqual([verdict.error]);
          if (verdict.on !== undefined) {
            expect(result.errors[0]!.connectionId).toBe(rows[verdict.on]!.id);
            expect(result.errors[0]!.source).toBe("fallback_auto");
          } else {
            // Nothing was bound, so no layer is named.
            expect(result.errors[0]!.source).toBeUndefined();
          }
        }
      });
    }
  }

  it("a colleague sharing a connection does not move a run that auto-bound my own", () => {
    const mine = own();
    const before = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [mine],
      pins: [],
    });
    const after = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [shared(), mine],
      pins: [],
    });
    expect(before.resolved[INTEG]!.map((r) => r.connectionId)).toEqual([mine.id]);
    expect(after.errors).toEqual([]);
    expect(after.resolved[INTEG]!.map((r) => r.connectionId)).toEqual([mine.id]);
    expect(after.resolved[INTEG]![0]!.source).toBe("fallback_auto");
  });

  it("my second account expiring is a choice, never a silent switch to the first", () => {
    const first = own({ label: "Boulot" });
    const second = own({ authKey: "pat", label: "Perso", ...DEAD });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [first, second],
      pins: [],
    });
    expect(result.resolved[INTEG]).toBeUndefined();
    expect(result.errors[0]!.code).toBe("must_choose_connection");
    expect(result.errors[0]!.candidateConnections!.map((c) => [c.id, c.needsReconnection])).toEqual(
      [
        [first.id, false],
        [second.id, true],
      ],
    );
  });

  it("an end-user with only a member's shared connection must choose — never bound to it", () => {
    const memberShared = shared();
    const result = resolveConnections({
      requirements: [requiredReq(oauth2Manifest())],
      accessibleConnections: [memberShared],
      pins: [],
      actorUserId: null,
      actorEndUserId: END_USER,
    });
    expect(result.resolved[INTEG]).toBeUndefined();
    expect(result.errors[0]!.code).toBe("must_choose_connection");
    expect(result.errors[0]!.message).toContain("shared by other members");
    expect(result.errors[0]!.candidateConnections).toEqual([
      {
        id: memberShared.id,
        label: memberShared.label,
        accountId: "acc_x",
        ownedByActor: false,
        needsReconnection: false,
      },
    ]);
  });

  it("a non-required integration offers an end-user a member's shared connection, never binding it", () => {
    const memberShared = shared();
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [memberShared],
      pins: [],
      actorUserId: null,
      actorEndUserId: END_USER,
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]).toEqual([]);
    expect(result.warnings[0]!.message).toContain("shared by other members");
    expect(result.warnings[0]!.candidateConnections).toEqual([
      {
        id: memberShared.id,
        label: memberShared.label,
        accountId: "acc_x",
        ownedByActor: false,
        needsReconnection: false,
      },
    ]);
  });

  it("control — an end-user's own connection binds over a member's shared one", () => {
    const mine = conn({ userId: null, endUserId: END_USER });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [shared(), mine],
      pins: [],
      actorUserId: null,
      actorEndUserId: END_USER,
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]!.map((r) => r.connectionId)).toEqual([mine.id]);
  });

  it("must_choose lists every serving row — own and shared, live and dead — flagged", () => {
    // What tells the candidates apart rides on each one, so a caller with no
    // picker (API, MCP) chooses from the error alone and can skip the dead ones.
    const mineLive = own({ label: "web", accountId: "root@web-01" });
    const mineDead = own({ authKey: "pat", label: "db", accountId: "root@db-01", ...DEAD });
    const theirsLive = shared({ label: "ops", accountId: "ops@corp" });
    const theirsDead = shared({ authKey: "pat", label: "ci", accountId: "ci@corp", ...DEAD });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [mineLive, mineDead, theirsLive, theirsDead],
      pins: [],
    });
    const err = result.errors[0]!;
    expect(err.code).toBe("must_choose_connection");
    expect(err.candidateConnections).toEqual([
      {
        id: mineLive.id,
        label: "web",
        accountId: "root@web-01",
        ownedByActor: true,
        needsReconnection: false,
      },
      {
        id: mineDead.id,
        label: "db",
        accountId: "root@db-01",
        ownedByActor: true,
        needsReconnection: true,
      },
      {
        id: theirsLive.id,
        label: "ops",
        accountId: "ops@corp",
        ownedByActor: false,
        needsReconnection: false,
      },
      {
        id: theirsDead.id,
        label: "ci",
        accountId: "ci@corp",
        ownedByActor: false,
        needsReconnection: true,
      },
    ]);
    // …and the snake_case projection the 409 envelope carries.
    expect(translateResolutionError(err)).toMatchObject({
      field: `integrations.${INTEG}`,
      code: "must_choose_connection",
      candidate_connections: [
        {
          id: mineLive.id,
          label: "web",
          account_id: "root@web-01",
          owned_by_actor: true,
          needs_reconnection: false,
        },
        {
          id: mineDead.id,
          label: "db",
          account_id: "root@db-01",
          owned_by_actor: true,
          needs_reconnection: true,
        },
        {
          id: theirsLive.id,
          label: "ops",
          account_id: "ops@corp",
          owned_by_actor: false,
          needs_reconnection: false,
        },
        {
          id: theirsDead.id,
          label: "ci",
          account_id: "ci@corp",
          owned_by_actor: false,
          needs_reconnection: true,
        },
      ],
    });
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
    expect(result.errors[0]!.source).toBe("fallback_auto");
  });

  it("needs_reconnection fires for pinned + override paths too, naming the layer", () => {
    const c = conn({ needsReconnection: true });
    const pinResult = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [pin(c.id)],
    });
    expect(pinResult.errors[0]!.code).toBe("needs_reconnection");
    expect(pinResult.errors[0]!.connectionId).toBe(c.id);
    expect(pinResult.errors[0]!.source).toBe("admin_pin");

    const overrideResult = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [],
      launchOverrides: scheduleOverride({ [INTEG]: [c.id] }),
    });
    expect(overrideResult.errors[0]!.code).toBe("needs_reconnection");
    expect(overrideResult.errors[0]!.source).toBe("schedule_override");
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
          required: false,
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
          required: true,
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

  const inertReq = (required: boolean): IntegrationRequirement => ({
    integrationId: INTEG,
    manifest: oauth2Manifest(),
    hasSelectedTools: false,
    agentTools: [],
    agentScopes: [],
    required,
  });

  it("skips integrations with no selected tools (declared-but-inert)", () => {
    const result = resolveConnections({
      requirements: [inertReq(false)],
      accessibleConnections: [],
      pins: [],
    });
    expect(result).toEqual({ resolved: {}, errors: [], warnings: [] });
  });

  it("does not skip a REQUIRED inert integration: it must still bind a connection", () => {
    const none = resolveConnections({
      requirements: [inertReq(true)],
      accessibleConnections: [],
      pins: [],
    });
    expect(none.resolved).toEqual({});
    expect(none.errors.map((e) => e.code)).toEqual(["not_connected"]);

    const c = conn({});
    const bound = resolveConnections({
      requirements: [inertReq(true)],
      accessibleConnections: [c],
      pins: [],
    });
    expect(bound.errors).toEqual([]);
    expect(bound.resolved[INTEG]).toMatchObject([{ connectionId: c.id, source: "fallback_auto" }]);

    const pinnedNone = resolveConnections({
      requirements: [inertReq(true)],
      accessibleConnections: [c],
      pins: [pin([])],
    });
    expect(pinnedNone.errors.map((e) => e.code)).toEqual(["required_integration_unbound"]);
  });

  function requiredAuthReq(required: boolean): IntegrationRequirement {
    return {
      integrationId: INTEG,
      manifest: requiredOauth2Manifest(),
      hasSelectedTools: false,
      hasMandatoryAuth: true,
      agentTools: [],
      agentScopes: [],
      required,
    };
  }

  it("blocks an inert integration whose manifest declares a required auth (no connection)", () => {
    const result = resolveConnections({
      requirements: [requiredAuthReq(true)],
      accessibleConnections: [],
      pins: [],
    });
    expect(result.resolved).toEqual({});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ integrationId: INTEG, code: "not_connected" });
  });

  it("a required auth makes a NON-required integration active, so it binds none with a warning", () => {
    const result = resolveConnections({
      requirements: [requiredAuthReq(false)],
      accessibleConnections: [],
      pins: [],
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved).toEqual({ [INTEG]: [] });
    expect(result.warnings.map((w) => w.code)).toEqual(["not_connected"]);
  });

  it("auto-resolves an inert required-auth integration when one healthy connection exists", () => {
    const c = conn({});
    const result = resolveConnections({
      requirements: [requiredAuthReq(false)],
      accessibleConnections: [c],
      pins: [],
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]).toMatchObject([{ connectionId: c.id }]);
  });
});

// #1871: a new connection for least privilege must not break the fallback of the actor's other
// agents. Own connections of ONE known account differ by scopes only: no account is chosen.
describe("resolveConnections — fallback among own connections of one account", () => {
  const narrow = () => conn({ label: "lecture", scopesGranted: ["read"] });
  const broad = () => conn({ label: "écriture", scopesGranted: ["read", "write"] });
  const fallback = (rows: ConnectionRow[], agentScopes: string[]) =>
    resolveConnections({
      requirements: [req(oauth2Manifest(), [], agentScopes)],
      accessibleConnections: rows,
      pins: [],
    });

  it("binds the narrow one when it covers the agent", () => {
    const [n, b] = [narrow(), broad()];
    const result = fallback([b, n], ["read"]);
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]).toMatchObject([{ connectionId: n.id, source: "fallback_auto" }]);
  });

  it("binds the broad one when only it covers the agent", () => {
    const [n, b] = [narrow(), broad()];
    const result = fallback([n, b], ["write"]);
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]).toMatchObject([{ connectionId: b.id }]);
  });

  it("binds the closest when none covers, which then answers insufficient_scopes", () => {
    const [n, b] = [narrow(), broad()];
    const result = fallback([n, b], ["read", "write", "admin"]);
    expect(result.resolved[INTEG]).toBeUndefined();
    expect(result.errors[0]).toMatchObject({
      code: "insufficient_scopes",
      connectionId: b.id,
      missingScopes: ["admin"],
      source: "fallback_auto",
    });
  });

  /** `oauth2Manifest()` whose oauth auth carries `defaults` and, optionally, a catalog. */
  function withDefaults(defaults: string[], catalog?: object[]): IntegrationManifest {
    const m = oauth2Manifest() as unknown as { auths: { oauth: Record<string, unknown> } };
    m.auths.oauth.default_scopes = defaults;
    if (catalog) m.auths.oauth.scope_catalog = catalog;
    return m as unknown as IntegrationManifest;
  }
  const bind = (manifest: IntegrationManifest, rows: ConnectionRow[], agentScopes: string[]) =>
    resolveConnections({
      requirements: [req(manifest, [], agentScopes)],
      accessibleConnections: rows,
      pins: [],
    });

  it("judges an agent declaring no scope on the auth's default_scopes", () => {
    // Without the defaults the narrower `lacking` row would win on breadth.
    const lacking = conn({ scopesGranted: ["read"] });
    const baseline = conn({ scopesGranted: ["base", "read"] });
    const result = bind(withDefaults(["base"]), [lacking, baseline], []);
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]).toMatchObject([{ connectionId: baseline.id }]);
  });

  it("never trades a narrow row short of a newer default for a write-capable one", () => {
    const narrowRow = conn({ scopesGranted: ["read"] });
    const writeRow = conn({ scopesGranted: ["base", "read", "write"] });
    for (const rows of [
      [narrowRow, writeRow],
      [writeRow, narrowRow],
    ]) {
      const result = bind(withDefaults(["base"]), rows, ["read"]);
      expect(result.resolved[INTEG]).toMatchObject([{ connectionId: narrowRow.id }]);
    }
  });

  it("prefers covering the agent over covering the defaults", () => {
    const missesAgent = conn({ scopesGranted: ["base", "read"] });
    const missesDefault = conn({ scopesGranted: ["write"] });
    const result = bind(withDefaults(["base"]), [missesAgent, missesDefault], ["write"]);
    expect(result.resolved[INTEG]).toMatchObject([{ connectionId: missesDefault.id }]);
  });

  // #1871: an expiry must not elevate a read-only agent onto the write-capable row.
  it("binds a dead narrow row over a live broad one, which answers needs_reconnection", () => {
    const deadNarrow = conn({ scopesGranted: ["read"], needsReconnection: true });
    const liveBroad = conn({ scopesGranted: ["read", "write"] });
    for (const rows of [
      [deadNarrow, liveBroad],
      [liveBroad, deadNarrow],
    ]) {
      const result = fallback(rows, ["read"]);
      expect(result.errors[0]).toMatchObject({
        code: "needs_reconnection",
        connectionId: deadNarrow.id,
      });
    }
  });

  it("expands `implies` when judging breadth: an umbrella is never narrower", () => {
    const manifest = withDefaults(
      [],
      [
        { value: "public_repo", label: "Public repos" },
        { value: "repo", label: "Repos", implies: ["public_repo"] },
      ],
    );
    // Older, so it would win a raw-count tie.
    const umbrella = conn({ scopesGranted: ["repo"], createdAt: new Date(1) });
    const exact = conn({ scopesGranted: ["public_repo"], createdAt: new Date(2) });
    const result = bind(manifest, [umbrella, exact], ["public_repo"]);
    expect(result.resolved[INTEG]).toMatchObject([{ connectionId: exact.id }]);
  });

  it("still asks without an agent selection (a credential-proxy call)", () => {
    const result = resolveConnections({
      requirements: [{ ...req(oauth2Manifest()), noAgentSelection: true }],
      accessibleConnections: [narrow(), broad()],
      pins: [],
    });
    expect(result.errors[0]!.code).toBe("must_choose_connection");
  });

  it("still asks across auths of one account", () => {
    const result = fallback([narrow(), conn({ authKey: "pat" })], ["read"]);
    expect(result.errors[0]!.code).toBe("must_choose_connection");
  });

  it("still asks across instances of one account (connection variables)", () => {
    const result = fallback(
      [
        conn({ scopesGranted: ["read"], variables: { host: "gitlab.com" } }),
        conn({ scopesGranted: ["read"], variables: { host: "gitlab.corp" } }),
      ],
      ["read"],
    );
    expect(result.errors[0]!.code).toBe("must_choose_connection");
  });

  it("judges breadth on catalog scopes, not on the IdP's echoed ones", () => {
    const manifest = oauth2Manifest() as unknown as {
      auths: { oauth: Record<string, unknown> };
    };
    manifest.auths.oauth.scope_catalog = [
      { value: "read", label: "Read" },
      { value: "write", label: "Write" },
    ];
    const echoed = conn({ scopesGranted: ["read", "openid", "profile", "email"] });
    const wide = conn({ scopesGranted: ["read", "write"] });
    const result = resolveConnections({
      requirements: [req(manifest as unknown as IntegrationManifest, [], ["read"])],
      accessibleConnections: [wide, echoed],
      pins: [],
    });
    expect(result.resolved[INTEG]).toMatchObject([{ connectionId: echoed.id }]);
  });

  it("breaks a tie on the live row, whatever the input order", () => {
    const dead = conn({ scopesGranted: ["read"], needsReconnection: true });
    const live = conn({ scopesGranted: ["read"] });
    for (const rows of [
      [dead, live],
      [live, dead],
    ]) {
      expect(fallback(rows, ["read"]).resolved[INTEG]).toMatchObject([{ connectionId: live.id }]);
    }
  });

  it("still asks across two accounts", () => {
    const result = fallback(
      [narrow(), conn({ accountId: "acc_y", scopesGranted: ["read"] })],
      ["read"],
    );
    expect(result.errors[0]!.code).toBe("must_choose_connection");
  });

  it("still asks when an identity is unknown", () => {
    const result = fallback(
      [
        conn({ accountId: "default", scopesGranted: ["read"] }),
        conn({ accountId: "default", scopesGranted: ["read", "write"] }),
      ],
      ["read"],
    );
    expect(result.errors[0]!.code).toBe("must_choose_connection");
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

// ─────────────────────────── Org default (layers 2 & 5) ───────────────────────

describe("resolveConnections — org default", () => {
  const ENFORCE = (...ids: string[]) => ({ [INTEG]: { connectionIds: ids, enforce: true } });
  const SOFT = (...ids: string[]) => ({ [INTEG]: { connectionIds: ids, enforce: false } });

  it("ENFORCE default refuses a launch override outside it with override_outranked", () => {
    const def = conn({ sharedWithOrg: true });
    const other = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [def, other],
      pins: [],
      launchOverrides: runOverride({ [INTEG]: [other.id] }),
      orgDefaults: ENFORCE(def.id),
    });
    expect(result.resolved[INTEG]).toBeUndefined();
    expect(result.errors[0]!.code).toBe("override_outranked");
    expect(result.errors[0]!.message).toContain("an enforced org default");
  });

  it("a SOFT default never outranks a launch override", () => {
    const def = conn({ sharedWithOrg: true });
    const other = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [def, other],
      pins: [],
      launchOverrides: runOverride({ [INTEG]: [other.id] }),
      orgDefaults: SOFT(def.id),
    });
    expect(result.resolved[INTEG]![0]!.source).toBe("run_override");
  });

  it("ENFORCE default wins over the member pin", () => {
    const def = conn({ sharedWithOrg: true });
    const other = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [def, other],
      pins: [memberPin(other.id)],
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
    expect(result.errors[0]!.source).toBe("org_default_enforced");
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

  it("SOFT default with an unreachable member fails loud — it never falls through to the fallback", () => {
    const onlyOne = conn({});
    const live = conn({ sharedWithOrg: true });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [onlyOne, live],
      pins: [],
      orgDefaults: SOFT(live.id, "conn_ghost"),
      actorUserId: USER_ID,
    });
    expect(result.resolved[INTEG]).toBeUndefined();
    expect(result.errors[0]!.code).toBe("pinned_connection_unavailable");
    expect(result.errors[0]!.source).toBe("org_default");
    expect(result.errors[0]!.message).toContain("conn_ghost");
  });

  it("a member pin still wins over a SOFT default whose member is gone", () => {
    const mine = conn({});
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [mine],
      pins: [memberPin(mine.id)],
      orgDefaults: SOFT("conn_ghost"),
      actorUserId: USER_ID,
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]![0]!.source).toBe("member_pin");
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
  function reqWithAuthKey(authKey: string, required = true): IntegrationRequirement {
    return {
      integrationId: INTEG,
      manifest: oauth2Manifest(),
      hasSelectedTools: true,
      agentTools: [],
      agentScopes: [],
      required,
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
    // An auth the manifest does not declare is no connect target.
    expect(err.authKey).toBeUndefined();
  });

  it("a non-required integration binds none on a mismatch, warning auth_key_mismatch with both keys", () => {
    const oauthConn = conn({ authKey: "oauth" });
    const result = resolveConnections({
      requirements: [reqWithAuthKey("pat", false)],
      accessibleConnections: [oauthConn],
      pins: [],
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]).toEqual([]);
    const warning = result.warnings[0]!;
    expect(warning).toMatchObject({
      code: "auth_key_mismatch",
      requiredAuthKey: "pat",
      availableAuthKeys: ["oauth"],
      // Connecting the dep's own auth clears it.
      authKey: "pat",
    });
    expect(warning.candidateConnections).toBeUndefined();
    expect(warning.message).toContain("requires auth 'pat'");
    const item = translateResolutionError(warning);
    expect(item).toMatchObject({
      field: `integrations.${INTEG}`,
      code: "auth_key_mismatch",
      required_auth_key: "pat",
      available_auth_keys: ["oauth"],
      auth_key: "pat",
    });
    expect(connectOfferTarget(item)).toEqual({ integrationId: INTEG, authKey: "pat", scopes: [] });
  });

  it("a non-required mismatch still yields to an explicit layer: a pin on the off-auth row fails", () => {
    const oauthConn = conn({ authKey: "oauth" });
    const result = resolveConnections({
      requirements: [reqWithAuthKey("pat", false)],
      accessibleConnections: [oauthConn],
      pins: [pin(oauthConn.id)],
    });
    expect(result.warnings).toEqual([]);
    expect(result.errors.map((e) => e.code)).toEqual(["pinned_connection_unavailable"]);
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
    expect(result.errors[0]!.message).toContain(
      "is on auth 'oauth', not the auth 'pat' this agent requires",
    );
    expect(result.errors[0]!.message).not.toContain("deleted or unshared");
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
      requirements: [requiredReq(oauth2Manifest())],
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

  it("names the orphaned auth when a pin binds the dropped row, not a deletion", () => {
    const live = conn({ authKey: "oauth" });
    const orphan = conn({ authKey: "legacy_primary" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [live, orphan],
      pins: [pin(orphan.id)],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe("pinned_connection_unavailable");
    expect(result.errors[0]!.message).toContain(
      "is on auth 'legacy_primary', which the integration no longer declares",
    );
  });

  it("keeps the deletion hint for a pin naming a row the actor cannot reach", () => {
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [conn({ authKey: "oauth" })],
      pins: [pin(crypto.randomUUID())],
    });
    expect(result.errors[0]!.message).toContain("may have been deleted or unshared");
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
      required: true,
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
    // …and the snake_case projection the 409 envelope carries. `owned_by_actor`
    // tells the caller whether upgrading THIS row is theirs to choose.
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
    // hand-built error: the wire names are what the 409 consumers parse.
    expect(translateResolutionError(err)).toMatchObject({
      field: `integrations.${INTEG}`,
      code: "not_connected",
      auth_key: "oauth",
      required_scopes: ["repo", "admin:repo", "user"],
    });
  });

  it("not_connected falls back to the integration's single serving auth when nothing is pinned", () => {
    const result = resolveConnections({
      requirements: [requiredReq(scopedManifest(), ["t1"], [])],
      accessibleConnections: [],
      pins: [],
      actorUserId: USER_ID,
    });
    const err = result.errors[0]!;
    expect(err.code).toBe("not_connected");
    expect(err.authKey).toBe("oauth");
    expect(err.requiredScopes).toEqual(["repo"]);
  });

  it("an optional not_connected warning carries the error's connect target, on the wire too", () => {
    const result = resolveConnections({
      requirements: [req(scopedManifest(), ["t1"], [])],
      accessibleConnections: [],
      pins: [],
    });
    expect(result.errors).toEqual([]);
    const warning = result.warnings[0]!;
    expect(warning).toMatchObject({
      code: "not_connected",
      authKey: "oauth",
      requiredScopes: ["repo"],
    });
    const item = translateResolutionError(warning);
    expect(item).toEqual({
      field: `integrations.${INTEG}`,
      code: "not_connected",
      title: expect.any(String),
      message: warning.message,
      auth_key: "oauth",
      required_scopes: ["repo"],
    });
  });

  it("not_connected emits neither field with two oauth2 auths and no pin", () => {
    // Guessing would send the user through the wrong provider's consent.
    const result = resolveConnections({
      requirements: [requiredReq(twoOauthManifest(), ["t1"], [])],
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
      requirements: [requiredReq(scopedManifest(), [], [])],
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

  it("not_connected on an api_key-only integration names that auth, with no scopes", () => {
    const result = resolveConnections({
      requirements: [requiredReq(apiKeyOnlyManifest(), ["t1"], [])],
      accessibleConnections: [],
      pins: [],
      actorUserId: USER_ID,
    });
    const err = result.errors[0]!;
    expect(err.code).toBe("not_connected");
    expect(err.authKey).toBe("pat");
    expect(err.requiredScopes).toBeUndefined();
    const field = translateResolutionError(err);
    expect(field).toMatchObject({ code: "not_connected", auth_key: "pat" });
    expect(field).not.toHaveProperty("required_scopes");
  });

  it("an optional not_connected on an api_key-only integration carries the same connect target", () => {
    const result = resolveConnections({
      requirements: [req(apiKeyOnlyManifest(), ["t1"], [])],
      accessibleConnections: [],
      pins: [],
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved).toEqual({ [INTEG]: [] });
    const warning = result.warnings[0]!;
    expect(warning).toMatchObject({ code: "not_connected", authKey: "pat" });
    expect(warning.requiredScopes).toBeUndefined();
    const field = translateResolutionError(warning);
    expect(field).toMatchObject({ code: "not_connected", auth_key: "pat" });
    expect(field).not.toHaveProperty("required_scopes");
  });

  it("an api_key-only integration bound to none by a pin names no connect target", () => {
    const result = resolveConnections({
      requirements: [req(apiKeyOnlyManifest(), ["t1"], [])],
      accessibleConnections: [],
      pins: [memberPin([])],
    });
    expect(result.warnings).toEqual([
      {
        integrationId: INTEG,
        code: "integration_unbound",
        source: "member_pin",
        message: expect.stringContaining("is bound to no connection by your pin"),
      },
    ]);
  });

  it("names no connect target when two non-oauth2 auths serve and the dep pins none", () => {
    const m = apiKeyOnlyManifest() as unknown as { auths: Record<string, unknown> };
    m.auths.basic = { ...structuredClone(m.auths.pat as object), type: "basic" };
    for (const required of [true, false]) {
      const result = resolveConnections({
        requirements: [{ ...req(m as unknown as IntegrationManifest, ["t1"], []), required }],
        accessibleConnections: [],
        pins: [],
      });
      const [item] = required ? result.errors : result.warnings;
      expect(item!.code).toBe("not_connected");
      expect(item!.authKey).toBeUndefined();
      expect(translateResolutionError(item!)).not.toHaveProperty("auth_key");
    }
  });

  it("among several serving auths, targets the single oauth2 one — the one a link can connect", () => {
    // oauth2Manifest declares `oauth` (oauth2) and `pat` (api_key), both serving.
    const result = resolveConnections({
      requirements: [requiredReq(oauth2Manifest())],
      accessibleConnections: [],
      pins: [],
    });
    expect(result.errors[0]).toMatchObject({ code: "not_connected", authKey: "oauth" });
  });

  it("needs_reconnection carries the dead connection's auth_key and NO required set", () => {
    // #1871: the reconnect re-consents what the row holds; carrying this agent's
    // scopes would widen every other agent bound to it.
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
    expect(err.requiredScopes).toBeUndefined();
    const field = translateResolutionError(err);
    expect(field).toMatchObject({
      field: `integrations.${INTEG}`,
      code: "needs_reconnection",
      connection_id: c.id,
      auth_key: "oauth",
      // Repairing the row in place is the owner's to do, and the connect-offer
      // mint reads this field.
      owned_by_actor: true,
    });
    expect(field).not.toHaveProperty("required_scopes");
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

// ─────────────────────── Connection SETS (N per integration) ──────────────────

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

  it("run override binds N connections", () => {
    const a = conn({ label: "web-1" });
    const b = conn({ authKey: "pat", label: "db" });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [a, b],
      pins: [],
      launchOverrides: runOverride({ [INTEG]: [a.id, b.id] }),
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]).toEqual([
      { connectionId: a.id, source: "run_override", label: "web-1", accountId: "acc_x" },
      { connectionId: b.id, source: "run_override", label: "db", accountId: "acc_x" },
    ]);
  });

  it("an ENFORCE org default of 2 is narrowed by an override naming one of its members", () => {
    const defA = conn({ label: "web-1", sharedWithOrg: true });
    const defB = conn({ authKey: "pat", label: "db", sharedWithOrg: true });
    const result = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [defA, defB],
      pins: [],
      orgDefaults: { [INTEG]: { connectionIds: [defA.id, defB.id], enforce: true } },
      launchOverrides: runOverride({ [INTEG]: [defB.id] }),
    });
    expect(result.resolved[INTEG]!.map((r) => [r.connectionId, r.source])).toEqual([
      [defB.id, "run_override"],
    ]);
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

  // Else its credentials would be injected under this integration's auth.
  it("a pin or override naming a reachable connection of ANOTHER integration binds nothing", () => {
    const own = conn({});
    const foreign = conn({ integrationId: "@vendor/other" });
    const codes = (input: Partial<Parameters<typeof resolveConnections>[0]>) =>
      resolveConnections({
        requirements: [req(oauth2Manifest())],
        accessibleConnections: [own, foreign],
        pins: [],
        ...input,
      }).errors.map((e) => e.code);
    expect(codes({ pins: [pin(foreign.id)] })).toEqual(["pinned_connection_unavailable"]);
    expect(codes({ launchOverrides: runOverride({ [INTEG]: [foreign.id] }) })).toEqual([
      "override_connection_unavailable",
    ]);
    // Control: the same override naming this integration's row binds it.
    expect(codes({ launchOverrides: runOverride({ [INTEG]: [own.id] }) })).toEqual([]);
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

  it("servingCandidates keeps only rows on a declared, pinned (if any) and serving auth", () => {
    const oauthRow = conn({ authKey: "oauth" });
    const patRow = conn({ authKey: "pat" });
    const orphan = conn({ authKey: "gone" });
    const rows = [oauthRow, patRow, orphan];
    const keyOf = (c: ConnectionRow) => c.authKey;

    // Serving filter: only `oauth` exposes the selected api_call.
    expect(
      servingCandidates(selecting(serverlessManifest(), ["api_call__oauth"]), rows, keyOf),
    ).toEqual([oauthRow]);
    // Dep's `auth_key` pin on an otherwise unconstrained selection.
    expect(
      servingCandidates({ ...req(oauth2Manifest()), requiredAuthKey: "pat" }, rows, keyOf),
    ).toEqual([patRow]);
    // Orphaned-auth guard alone: an inert selection serves every declared auth.
    expect(servingCandidates(req(oauth2Manifest()), rows, keyOf)).toEqual([oauthRow, patRow]);
  });

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
      requirements: [{ ...selecting(serverlessManifest(), ["api_call__oauth"]), required: true }],
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

  it("non-required, only a non-serving connection: the warning names the serving-auth cause", () => {
    const b = conn({ authKey: "pat", label: "spare" });
    const result = resolveConnections({
      requirements: [selecting(serverlessManifest(), ["api_call__oauth"])],
      accessibleConnections: [b],
      pins: [],
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved).toEqual({ [INTEG]: [] });
    expect(result.warnings).toEqual([
      {
        integrationId: INTEG,
        code: "not_connected",
        authKey: "oauth",
        message: `Integration '${INTEG}' has no connection accessible to this actor on an auth that exposes the agent's selected tools; the run proceeds without it.`,
      },
    ]);
    expect(translateResolutionError(result.warnings[0]!).title).toBe("Integration Not Connected");
  });

  it("targets the lone serving auth whatever its type, and the mint stays a pure decision", () => {
    const result = resolveConnections({
      requirements: [{ ...selecting(serverlessManifest(), ["api_call__pat"]), required: true }],
      accessibleConnections: [],
      pins: [],
      actorUserId: USER_ID,
    });
    const err = result.errors[0]!;
    expect(err.code).toBe("not_connected");
    expect(err.authKey).toBe("pat");
    expect(err.requiredScopes).toBeUndefined();
    // `attachConnectOffers` is what refuses a link for a non-oauth2 auth.
    expect(connectOfferTarget(translateResolutionError(err))).toEqual({
      integrationId: INTEG,
      authKey: "pat",
      scopes: [],
    });
  });

  // The agent's own `auth_key` serving no selected tool is its configuration, answered before
  // the `auth_key` filter, pins, overrides or the fallback: each case below would otherwise
  // surface a connection remedy (not_connected, auth_key_mismatch, "remove it from the set").
  it("answers auth_key_serves_no_selected_tool whatever the actor holds", () => {
    const requiresPat = {
      ...selecting(serverlessManifest(), ["api_call__oauth"]),
      requiredAuthKey: "pat",
    };
    const onServing = conn({ label: "main" });
    const onRequired = conn({ authKey: "pat", label: "spare" });
    const cases = [
      { accessibleConnections: [], pins: [] },
      { accessibleConnections: [onServing], pins: [] },
      { accessibleConnections: [onRequired], pins: [pin([onRequired.id])] },
    ];
    for (const c of cases) {
      const result = resolveConnections({
        requirements: [requiresPat],
        ...c,
        actorUserId: USER_ID,
      });
      expect(result.resolved[INTEG]).toBeUndefined();
      expect(result.errors).toHaveLength(1);
      const err = result.errors[0]!;
      expect(err.code).toBe("auth_key_serves_no_selected_tool");
      expect(err.connectionId).toBeUndefined();
      expect(err.message).toContain("'pat'");
      expect(err.message).toContain("oauth");
      const item = translateResolutionError(err);
      expect(item).toMatchObject({ required_auth_key: "pat" });
      expect(item.connection_id).toBeUndefined();
      expect(item.auth_key).toBeUndefined();
      expect(connectOfferTarget(item)).toBeNull();
    }
  });

  it("control — an auth_key on a serving auth leaves the cascade to answer", () => {
    const onServing = conn({ label: "main" });
    const result = resolveConnections({
      requirements: [
        { ...selecting(serverlessManifest(), ["api_call__oauth"]), requiredAuthKey: "oauth" },
      ],
      accessibleConnections: [onServing],
      pins: [],
      actorUserId: USER_ID,
    });
    expect(result.errors).toEqual([]);
    expect(result.resolved[INTEG]!.map((r) => r.connectionId)).toEqual([onServing.id]);
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

// ─────────────────── Explicit none (`[]`) vs an absent layer ───────────────────

describe("resolveConnections — explicit none (`[]`) vs an absent layer", () => {
  type Input = Parameters<typeof resolveConnections>[0];
  type Layer = {
    name: string;
    source: ConnectionResolutionSource;
    /** The layer's slice of the input; `null` = no row / no key. */
    input: (ids: string[] | null) => Partial<Input>;
  };

  const orgDefault = (ids: string[] | null, enforce: boolean): Partial<Input> => ({
    orgDefaults: ids === null ? {} : { [INTEG]: { connectionIds: ids, enforce } },
  });
  const layers: Layer[] = [
    {
      name: "admin pin",
      source: "admin_pin",
      input: (ids) => ({ pins: ids === null ? [] : [pin(ids)] }),
    },
    {
      name: "enforced org default",
      source: "org_default_enforced",
      input: (ids) => orgDefault(ids, true),
    },
    {
      name: "run override",
      source: "run_override",
      // Absent = no key for this integration, the map itself present.
      input: (ids) => ({ launchOverrides: runOverride(ids === null ? {} : { [INTEG]: ids }) }),
    },
    {
      name: "schedule override",
      source: "schedule_override",
      input: (ids) => ({
        launchOverrides: scheduleOverride(ids === null ? {} : { [INTEG]: ids }),
      }),
    },
    {
      name: "member pin",
      source: "member_pin",
      input: (ids) => ({ pins: ids === null ? [] : [memberPin(ids)] }),
    },
    { name: "soft org default", source: "org_default", input: (ids) => orgDefault(ids, false) },
  ];

  /** One own connection: the fallback would bind it, so binding none proves the layer won. */
  function resolveWith(layerInput: Partial<Input>, required: boolean) {
    const mine = conn({});
    const result = resolveConnections({
      requirements: [{ ...req(oauth2Manifest()), required }],
      accessibleConnections: [mine],
      pins: [],
      ...layerInput,
    });
    return { mine, result };
  }

  for (const layer of layers) {
    it(`${layer.name} absent → the next layer decides (fallback binds the own row)`, () => {
      for (const required of [true, false]) {
        const { mine, result } = resolveWith(layer.input(null), required);
        expect(result.errors).toEqual([]);
        expect(result.resolved[INTEG]).toMatchObject([
          { connectionId: mine.id, source: "fallback_auto" },
        ]);
      }
    });

    it(`${layer.name} \`[]\`, non-required → integration_unbound naming the layer, no connect target`, () => {
      const { result } = resolveWith(layer.input([]), false);
      expect(result.errors).toEqual([]);
      expect(result.resolved).toEqual({ [INTEG]: [] });
      expect(result.warnings).toHaveLength(1);
      const [warning] = result.warnings;
      // A chosen absence: nothing to connect, so no link is minted for it.
      expect(warning).toEqual({
        integrationId: INTEG,
        code: "integration_unbound",
        source: layer.source,
        message: expect.stringContaining("is bound to no connection by"),
      });
      const item = translateResolutionError(warning!);
      expect(item).toMatchObject({ code: "integration_unbound", source: layer.source });
      expect(connectOfferTarget(item)).toBeNull();
    });

    it(`${layer.name} \`[]\`, required → required_integration_unbound naming the layer`, () => {
      const { result } = resolveWith(layer.input([]), true);
      expect(result.resolved[INTEG]).toBeUndefined();
      expect(result.warnings).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        integrationId: INTEG,
        code: "required_integration_unbound",
        source: layer.source,
        boundConnectionIds: [],
      });
      expect(translateResolutionError(result.errors[0]!)).toMatchObject({
        field: `integrations.${INTEG}`,
        code: "required_integration_unbound",
        title: "Required Integration Bound To No Connection",
        source: layer.source,
      });
    });
  }

  it("a higher `[]` outranks a lower non-empty layer, and a higher set outranks a lower `[]`", () => {
    const c = conn({});
    const memberNone = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [memberPin([])],
      orgDefaults: { [INTEG]: { connectionIds: [c.id], enforce: false } },
    });
    expect(memberNone.resolved).toEqual({ [INTEG]: [] });

    const adminSet = resolveConnections({
      requirements: [req(oauth2Manifest())],
      accessibleConnections: [c],
      pins: [pin(c.id), memberPin([])],
    });
    expect(adminSet.resolved[INTEG]).toMatchObject([{ connectionId: c.id, source: "admin_pin" }]);
  });

  describe("a launch override of `[]` under governance", () => {
    const governed = (c: ConnectionRow): { name: string; input: Partial<Input> }[] => [
      { name: "admin pin", input: { pins: [pin(c.id)] } },
      {
        name: "enforced org default",
        input: { orgDefaults: { [INTEG]: { connectionIds: [c.id], enforce: true } } },
      },
    ];

    for (const launch of [runOverride, scheduleOverride]) {
      const source = launch({}).source;
      it(`${source} \`[]\`: none is a subset — non-required binds none`, () => {
        const c = conn({});
        for (const g of governed(c)) {
          const result = resolveConnections({
            requirements: [req(oauth2Manifest())],
            accessibleConnections: [c],
            pins: [],
            ...g.input,
            launchOverrides: launch({ [INTEG]: [] }),
          });
          expect(result.errors).toEqual([]);
          expect(result.resolved).toEqual({ [INTEG]: [] });
        }
      });

      it(`${source} \`[]\`: required → required_integration_unbound, not override_outranked`, () => {
        const c = conn({});
        for (const g of governed(c)) {
          const result = resolveConnections({
            requirements: [requiredReq(oauth2Manifest())],
            accessibleConnections: [c],
            pins: [],
            ...g.input,
            launchOverrides: launch({ [INTEG]: [] }),
          });
          expect(result.errors).toHaveLength(1);
          expect(result.errors[0]).toMatchObject({
            code: "required_integration_unbound",
            source,
          });
        }
      });
    }

    it("an admin pin of `[]` outranks any override that names a connection", () => {
      const c = conn({});
      const result = resolveConnections({
        requirements: [req(oauth2Manifest())],
        accessibleConnections: [c],
        pins: [pin([])],
        launchOverrides: runOverride({ [INTEG]: [c.id] }),
      });
      expect(result.errors.map((e) => e.code)).toEqual(["override_outranked"]);
    });
  });

  it("an inert integration stays absent from the map, `[]` layer or not", () => {
    const result = resolveConnections({
      requirements: [{ ...req(oauth2Manifest()), hasSelectedTools: false }],
      accessibleConnections: [],
      pins: [pin([])],
    });
    expect(result).toEqual({ resolved: {}, errors: [], warnings: [] });
  });
});

describe("resolveConnections — integration switched off in the space", () => {
  const inactive = { inactiveIntegrationIds: new Set([INTEG]) };

  it("non-required: bound to none, warned `integration_not_active`, whatever would bind", () => {
    const c = conn({});
    for (const pins of [[], [pin(c.id)], [pin([])]]) {
      const result = resolveConnections({
        requirements: [req(oauth2Manifest())],
        accessibleConnections: [c],
        pins,
        ...inactive,
      });
      expect(result.errors).toEqual([]);
      // Listed unbound on the run; the spawn still drops it as `not_active`.
      expect(result.resolved).toEqual({ [INTEG]: [] });
      expect(result.warnings).toEqual([
        {
          integrationId: INTEG,
          code: "integration_not_active",
          message: `Integration '${INTEG}' is not active in this space; the run proceeds without it.`,
        },
      ]);
    }
  });

  it("required: `integration_not_active` error, with no connect target on the wire", () => {
    const result = resolveConnections({
      requirements: [requiredReq(oauth2Manifest())],
      accessibleConnections: [],
      pins: [],
      ...inactive,
    });
    expect(result.warnings).toEqual([]);
    expect(result.resolved).toEqual({});
    expect(result.errors).toEqual([
      {
        integrationId: INTEG,
        code: "integration_not_active",
        message: `Integration '${INTEG}' is not active in this space.`,
      },
    ]);
    const wire = translateResolutionError(result.errors[0]!);
    expect(wire).toEqual({
      field: `integrations.${INTEG}`,
      code: "integration_not_active",
      title: "Integration Not Active",
      message: `Integration '${INTEG}' is not active in this space.`,
    });
    expect(connectOfferTarget(wire)).toBeNull();
  });

  it("an inert non-required integration says nothing, as it does when active", () => {
    const result = resolveConnections({
      requirements: [{ ...req(oauth2Manifest()), hasSelectedTools: false }],
      accessibleConnections: [],
      pins: [],
      ...inactive,
    });
    expect(result).toEqual({ resolved: {}, errors: [], warnings: [] });
  });

  it("a required integration with nothing selected is still judged: `integration_not_active`", () => {
    const result = resolveConnections({
      requirements: [{ ...requiredReq(oauth2Manifest()), hasSelectedTools: false }],
      accessibleConnections: [],
      pins: [],
      ...inactive,
    });
    expect(result.errors.map((e) => e.code)).toEqual(["integration_not_active"]);
  });
});

describe("resolveConnections — a warning carries the code its state raises on a required integration", () => {
  /** One degraded state, `required` aside; the explicit `[]` pair is covered per layer above. */
  const states: {
    code: ConnectionResolutionWarningCode;
    requirement: IntegrationRequirement;
    input: () => Partial<Parameters<typeof resolveConnections>[0]>;
  }[] = [
    { code: "not_connected", requirement: req(oauth2Manifest()), input: () => ({}) },
    {
      code: "must_choose_connection",
      requirement: req(oauth2Manifest()),
      input: () => ({
        accessibleConnections: [conn({ userId: "user_colleague", sharedWithOrg: true })],
      }),
    },
    {
      code: "auth_key_mismatch",
      requirement: { ...req(oauth2Manifest()), requiredAuthKey: "pat" },
      input: () => ({ accessibleConnections: [conn({ authKey: "oauth" })] }),
    },
    {
      code: "integration_not_active",
      requirement: req(oauth2Manifest()),
      input: () => ({
        accessibleConnections: [conn({})],
        inactiveIntegrationIds: new Set([INTEG]),
      }),
    },
  ];

  for (const { code, requirement, input } of states) {
    it(`${code}: the same item, an error when required and a warning otherwise`, () => {
      const layers = input();
      const [error, warning] = [true, false].map((required) => {
        const result = resolveConnections({
          requirements: [{ ...requirement, required }],
          accessibleConnections: [],
          pins: [],
          ...layers,
        });
        const items = required ? result.errors : result.warnings;
        expect(items).toHaveLength(1);
        expect(items[0]!.code).toBe(code);
        // Only the message's ending differs: refused, or "the run proceeds without it".
        const { message: _internal, ...internal } = items[0]!;
        const { message: _wire, ...wire } = translateResolutionError(items[0]!);
        return { internal, wire };
      });
      expect(warning).toEqual(error!);
    });
  }

  it("covers every warning code with an error twin", () => {
    expect(states.map((s) => s.code).sort()).toEqual(
      CONNECTION_RESOLUTION_WARNING_CODES.filter((c) => c !== "integration_unbound").sort(),
    );
  });
});
