// SPDX-License-Identifier: Apache-2.0

/**
 * POST /api/runs/inline (+ /inline/validate) — connection disambiguation.
 *
 * The sibling suite `runs-412-missing-connection.test.ts` pins the same
 * contract for the cataloged agent route. This one exists because the inline
 * route reaches the readiness gate through a DIFFERENT path: its preflight
 * runs BEFORE `parseRequestInput`, so the caller's `connection_overrides` only
 * reach the resolver if the inline body schema declares the field AND
 * `runInlinePreflight` forwards it as `runOverrides`. While that wiring was
 * missing, an inline caller facing >1 candidate connection could never escape
 * the 412 — the picker had a remedy the route refused to accept. That is the
 * chat/MCP `run_and_wait` path, so the loop was unexitable there too.
 *
 * Covered here:
 *   - >1 candidate + no pick        → 412 must_choose_connection (unchanged)
 *   - >1 candidate + a valid pick   → launch, and the persisted run row carries
 *                                     both `connection_overrides` and the
 *                                     matching `resolved_connections` snapshot
 *   - /inline/validate parity       → same verdict as the launch, both ways
 *   - empty connection id           → 400 from the shared inline body schema, on
 *                                     BOTH routes, declared integration or not
 *                                     (`parseRequestInput` cannot own this here:
 *                                     it runs after the preflight on the launch
 *                                     route and not at all on validate)
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { runs } from "@appstrate/db/schema";
import {
  createFakeOrchestrator,
  inlineAgentManifest as inlineManifest,
  seedConnectionTestIntegration,
  seedIntegrationConnection,
  seedDefaultOrgModel,
  waitForRunPipelineSettled,
} from "../../helpers/run-connection-fixtures.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/space-packages.ts";
import { localIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { RUN_CONNECT_OFFERS_HEADER } from "@appstrate/core/run-and-wait-client";
import { readConnectToken } from "../../../src/services/connect/connect-session.ts";

const app = getTestApp();

const INTEGRATION = "@inlineconn/svc";

interface ValidationFieldError {
  field?: string;
  param?: string;
  code: string;
  title?: string;
  message: string;
  candidate_connection_ids?: string[];
  connect_url?: string;
  expires_at?: number;
  package_id?: string;
}

interface ProblemDetails {
  title?: string;
  status?: number;
  code?: string;
  detail?: string;
  param?: string;
  errors?: ValidationFieldError[];
}

describe("POST /api/runs/inline — connection_overrides disambiguation", () => {
  let ctx: TestContext;

  beforeAll(() => {
    _setOrchestratorForTesting(createFakeOrchestrator());
  });

  afterAll(() => {
    _setOrchestratorForTesting(null);
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "inlineconn" });
  });

  // Drain in `afterEach`, never at the tail of a test body: the trigger is
  // fire-and-forget, so a FAILING assertion would skip the drain and leave the
  // pipeline's background writes racing the next test's `truncateAll()` — one
  // red test would cascade into unrelated FK failures.
  afterEach(waitForRunPipelineSettled);

  const seedIntegration = (id: string) => seedConnectionTestIntegration(ctx, id);
  const seedConnection = (integrationId: string) => seedIntegrationConnection(ctx, integrationId);
  const seedDefaultModel = () => seedDefaultOrgModel(ctx);

  async function post(path: string, body: unknown) {
    return app.request(path, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 412 must_choose_connection when the actor has >1 candidate and sends no pick", async () => {
    await seedIntegration(INTEGRATION);
    const conn1 = await seedConnection(INTEGRATION);
    const conn2 = await seedConnection(INTEGRATION);

    const res = await post("/api/runs/inline", {
      manifest: inlineManifest([INTEGRATION]),
      prompt: "do the thing",
    });

    expect(res.status).toBe(412);
    const body = (await res.json()) as ProblemDetails;
    expect(body.code).toBe("missing_integration_connection");

    const err = body.errors!.find((e) => e.field === `integrations.${INTEGRATION}`);
    expect(err).toBeDefined();
    expect(err!.code).toBe("must_choose_connection");
    // The remedy the caller is handed — it must be actionable on THIS route.
    expect(err!.candidate_connection_ids!.sort()).toEqual([conn1, conn2].sort());
  });

  it("launches when connection_overrides names a candidate, persisting the pick and its snapshot", async () => {
    await seedIntegration(INTEGRATION);
    await seedDefaultModel();
    const picked = await seedConnection(INTEGRATION);
    // Second candidate — its existence is what makes the resolver enter
    // must_choose; the pick must silence it.
    await seedConnection(INTEGRATION);

    const res = await post("/api/runs/inline", {
      manifest: inlineManifest([INTEGRATION]),
      prompt: "do the thing",
      connection_overrides: { [INTEGRATION]: picked },
    });

    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    expect(created.id).toStartWith("run_");

    const [row] = await db.select().from(runs).where(eq(runs.id, created.id));
    expect(row).toBeDefined();
    // Mechanism #2 audit trail — what the caller asked for.
    expect(row!.connectionOverrides).toEqual({ [INTEGRATION]: picked });
    // …and the resolver snapshot the spawn loader + MITM refresh read back.
    expect(row!.resolvedConnections).toMatchObject({
      [INTEGRATION]: { connectionId: picked },
    });
  });

  it("POST /api/runs/inline/validate agrees with the launch — pick clears, absence does not", async () => {
    await seedIntegration(INTEGRATION);
    const picked = await seedConnection(INTEGRATION);
    await seedConnection(INTEGRATION);

    // Without a pick the dry-run validator reports the same unresolved
    // integration the launch would refuse — accumulated as a 400.
    const without = await post("/api/runs/inline/validate", {
      manifest: inlineManifest([INTEGRATION]),
      prompt: "do the thing",
    });
    expect(without.status).toBe(400);
    const withoutBody = (await without.json()) as ProblemDetails;
    const err = withoutBody.errors!.find((e) => e.field === `integrations.${INTEGRATION}`);
    expect(err).toBeDefined();
    expect(err!.code).toBe("must_choose_connection");

    // With the pick it reports ready — a validator that disagreed with the
    // launch about connection readiness would be worse than none.
    const withPick = await post("/api/runs/inline/validate", {
      manifest: inlineManifest([INTEGRATION]),
      prompt: "do the thing",
      connection_overrides: { [INTEGRATION]: picked },
    });
    expect(withPick.status).toBe(200);
    expect(await withPick.json()).toEqual({ valid: true });
  });

  // An empty connection id is falsy at the resolver's `resolveOne`, so the
  // override layer is skipped and readiness answers 412 — which is why this
  // guard cannot live downstream of the preflight. It is enforced on the shared
  // inline body schema so BOTH routes answer identically, and it must fire even
  // when the manifest declares the integration (the case where readiness would
  // otherwise get there first).
  describe.each([
    ["/api/runs/inline", "launch"],
    ["/api/runs/inline/validate", "validate"],
  ])("empty connection id on %s (%s)", (path) => {
    it("400s with the offending entry named, with no integration declared", async () => {
      const res = await post(path, {
        manifest: inlineManifest(),
        prompt: "do the thing",
        connection_overrides: { [INTEGRATION]: "" },
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ProblemDetails;
      const err = body.errors!.find((e) => e.field === `connection_overrides.${INTEGRATION}`);
      expect(err).toBeDefined();
      // Pinned to the Zod `too_small` code so a `.min(1)` reverted to plain
      // `z.string()` fails here rather than silently launching: with no
      // integration declared there is no readiness error to take its place.
      expect(err!.code).toBe("out_of_range");

      // No run row and no shadow package leaked from the rejected request.
      expect(await db.select().from(runs)).toHaveLength(0);
    });

    it("400s with the offending entry named even when the integration IS declared", async () => {
      await seedIntegration(INTEGRATION);
      await seedConnection(INTEGRATION);
      await seedConnection(INTEGRATION);

      const res = await post(path, {
        manifest: inlineManifest([INTEGRATION]),
        prompt: "do the thing",
        connection_overrides: { [INTEGRATION]: "" },
      });

      // Deterministically the body guard, NOT the 412 readiness would-be
      // answer: the parse happens before the preflight ever runs.
      expect(res.status).toBe(400);
      const body = (await res.json()) as ProblemDetails;
      expect(body.code).not.toBe("missing_integration_connection");
      expect(body.errors!.some((e) => e.field === `connection_overrides.${INTEGRATION}`)).toBe(
        true,
      );

      expect(await db.select().from(runs)).toHaveLength(0);
    });
  });

  // ─── Connect-offer relay (#1207) ───────────
  //
  // The inline route is the one the chat's `run_and_wait` actually launches
  // through, so the relay has to reach the fail-fast preflight and not just the
  // cataloged-agent route. `/inline/validate` is the deliberate exception: it
  // launches nothing, and a dry run must not burn a single-use capability.
  describe("connect_url relay", () => {
    const OAUTH_INTEGRATION = "@inlineconn/oauth-svc";

    function oauthManifest() {
      return localIntegrationManifest({
        name: OAUTH_INTEGRATION,
        serverName: `${OAUTH_INTEGRATION}-server`,
        version: "1.0.0",
        auths: {
          primary: {
            type: "oauth2",
            authorizationEndpoint: "https://provider.example.com/authorize",
            tokenEndpoint: "https://provider.example.com/token",
            defaultScopes: ["base"],
          },
        },
        tools_policy: { search: { required_scopes: { primary: ["search.read"] } } },
      }) as unknown as Record<string, unknown>;
    }

    async function seedOauthIntegration() {
      await seedPackage({
        id: OAUTH_INTEGRATION,
        orgId: ctx.orgId,
        type: "integration",
        source: "local",
        draftManifest: oauthManifest(),
      });
      await seedPackageVersion({
        packageId: OAUTH_INTEGRATION,
        version: "1.0.0",
        manifest: oauthManifest(),
      });
      await installPackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, OAUTH_INTEGRATION);
    }

    async function launch(path: string, headers: Record<string, string>) {
      return app.request(path, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          manifest: inlineManifest([OAUTH_INTEGRATION]),
          prompt: "do the thing",
        }),
      });
    }

    // The offer's full wire shape (`package_id`, `expires_at`, the permission
    // gate, the non-oauth2 refusal) is the mint's own contract and is pinned
    // once, on the cataloged-agent route in the sibling suite. What is proven
    // HERE is only what that suite cannot: that this route reaches the same
    // mint, with this route's own actor and space in the claims.
    it("routes the launch through the same mint when the caller opts in", async () => {
      await seedOauthIntegration();

      const res = await launch("/api/runs/inline", { [RUN_CONNECT_OFFERS_HEADER]: "1" });
      expect(res.status).toBe(412);
      const body = (await res.json()) as ProblemDetails;
      const err = body.errors!.find((e) => e.field === `integrations.${OAUTH_INTEGRATION}`)!;
      expect(err.code).toBe("not_connected");
      expect(err.connect_url).toStartWith("http");

      // A URL that opens is worthless if it asks for the wrong scopes on the
      // wrong auth in the wrong space — the claims are the security-relevant
      // output, and the manifest here selects `search`, whose
      // `required_scopes.primary` is `search.read`.
      const token = new URL(err.connect_url!).searchParams.get("token");
      expect(readConnectToken(token!)).toMatchObject({
        org_id: ctx.orgId,
        space_id: ctx.defaultSpaceId,
        user_id: ctx.user.id,
        package_id: OAUTH_INTEGRATION,
        auth_key: "primary",
        scopes: ["search.read"],
      });

      // Refused before any durable side effect, link or no link.
      expect(await db.select().from(runs)).toHaveLength(0);
    });

    it("mints nothing on the launch route without the header", async () => {
      await seedOauthIntegration();

      const res = await launch("/api/runs/inline", {});
      expect(res.status).toBe(412);
      const body = (await res.json()) as ProblemDetails;
      const err = body.errors!.find((e) => e.field === `integrations.${OAUTH_INTEGRATION}`)!;
      expect(err.connect_url).toBeUndefined();
    });

    it("never mints on /inline/validate, header or not", async () => {
      await seedOauthIntegration();

      const headerSets: Record<string, string>[] = [{}, { [RUN_CONNECT_OFFERS_HEADER]: "1" }];
      for (const headers of headerSets) {
        const res = await launch("/api/runs/inline/validate", headers);
        // Accumulate mode answers `validation_failed` (400), not the launch
        // route's 412 envelope — the readiness entries ride the same `errors[]`.
        expect(res.status).toBe(400);
        const body = (await res.json()) as ProblemDetails;
        const err = body.errors!.find((e) => e.field === `integrations.${OAUTH_INTEGRATION}`)!;
        expect(err.code).toBe("not_connected");
        expect(err.connect_url).toBeUndefined();
      }
    });
  });
});
