// SPDX-License-Identifier: Apache-2.0

/**
 * MCP `run_and_wait` × `connection_overrides` — the joined seam.
 *
 * An org with two connections on one integration auth makes run readiness answer
 * `409 missing_integration_connection` / `must_choose_connection`, and the only
 * documented way out is retrying with a `connection_overrides` map. That remedy
 * crosses TWO layers, and it was broken in both at once:
 *
 *   - the MCP tool did not declare the argument and the shared launch client
 *     did not put it in the launch body (unit-covered in
 *     `packages/core/test/run-and-wait-client.test.ts` +
 *     `apps/api/test/unit/modules/mcp/run-and-wait.test.ts`);
 *   - `POST /api/runs/inline` stripped the field and never handed it to the
 *     readiness resolver (covered in
 *     `apps/api/test/integration/routes/inline-run-missing-connection.test.ts`).
 *
 * Each side is now pinned in isolation, and isolation is exactly what let the
 * bug ship: either half could regress — a dropped tool property, a renamed wire
 * field — with both suites still green. This file is the one place where the
 * whole chain runs: a real MCP `tools/call` over the real router, the real
 * in-process dispatch, the real inline route, the real DB.
 *
 * Both directions live here on purpose. The 409 is what makes the override
 * necessary and the override is what makes the 409 escapable; asserting them
 * apart would let one drift into no longer describing the other.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { runs } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { truncateAll, db } from "../../../../../test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../../../test/helpers/auth.ts";
import {
  createFakeOrchestrator,
  inlineAgentManifest,
  seedConnectionTestIntegration,
  seedIntegrationConnection,
  seedDefaultOrgModel,
  waitForRunPipelineSettled,
} from "../../../../../test/helpers/run-connection-fixtures.ts";
import { _setOrchestratorForTesting } from "../../../../services/orchestrator/index.ts";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";
import { MCP_ACCEPT, type JsonRpcEnvelope } from "../../../../../test/helpers/mcp.ts";
import { seedPackage, seedPackageVersion } from "../../../../../test/helpers/seed.ts";
import { localIntegrationManifest } from "../../../../../test/helpers/integration-manifests.ts";
import { activatePackage } from "../../../../services/space-packages.ts";

const app = getTestApp();
// Wire in-process dispatch to the test app — without it `run_and_wait` has no
// platform to launch the run against (production registers its app in
// `index.ts` once every route is mounted).
await registerTestPlatformApp();

const INTEGRATION = "@mcpconn/svc";

/** Call an MCP tool on the caller's per-org endpoint and parse its JSON payload. */
async function callTool(
  headers: Record<string, string>,
  name: string,
  args: Record<string, unknown>,
  query = "",
): Promise<{ isError: boolean; data: Record<string, unknown> }> {
  const res = await app.request(`/api/mcp/o/${headers["X-Org-Id"]}${query}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const envelope = JSON.parse(await res.text()) as JsonRpcEnvelope;
  const content = (envelope.result?.content as Array<{ type: string; text: string }>) ?? [];
  const first = content.find((c) => c.type === "text");
  return {
    isError: Boolean(envelope.result?.isError),
    data: first ? (JSON.parse(first.text) as Record<string, unknown>) : {},
  };
}

interface ValidationFieldError {
  field?: string;
  code: string;
  message: string;
  candidate_connections?: {
    id: string;
    label: string | null;
    account_id: string;
    owned_by_actor: boolean;
    needs_reconnection: boolean;
  }[];
}

interface ProblemDetails {
  code?: string;
  detail?: string;
  errors?: ValidationFieldError[];
}

describe("mcp run_and_wait — connection_overrides", () => {
  let ctx: TestContext;
  let headers: Record<string, string>;

  beforeAll(() => {
    _setOrchestratorForTesting(createFakeOrchestrator());
  });

  afterAll(() => {
    _setOrchestratorForTesting(null);
  });

  beforeEach(async () => {
    await truncateAll();
    // A session owner: it holds mcp:read + mcp:invoke AND the `agents:run`
    // the dispatched inline route enforces, so nothing but the connection
    // ambiguity can decide the outcome.
    ctx = await createTestContext({ orgSlug: "mcpconn" });
    headers = authHeaders(ctx);
  });

  // Drain in `afterEach`, never at the tail of a test body: the trigger is
  // fire-and-forget, so a FAILING assertion would skip the drain and leave the
  // pipeline's background writes racing the next test's `truncateAll()` — one
  // red test would cascade into unrelated FK failures.
  afterEach(waitForRunPipelineSettled);

  it("returns the 409 must_choose_connection payload through the tool when no pick is given", async () => {
    await seedConnectionTestIntegration(ctx, INTEGRATION);
    const conn1 = await seedIntegrationConnection(ctx, INTEGRATION);
    const conn2 = await seedIntegrationConnection(ctx, INTEGRATION);

    const result = await callTool(headers, "run_and_wait", {
      kind: "inline",
      manifest: inlineAgentManifest([INTEGRATION]),
      prompt: "do the thing",
    });

    expect(result.isError).toBe(true);
    // The tool surfaces the route's own status + body — the model needs BOTH
    // the code and the candidates to build the retry.
    expect(result.data.status).toBe(409);
    const body = result.data.body as ProblemDetails;
    expect(body.code).toBe("missing_integration_connection");
    const err = body.errors!.find((e) => e.field === `integrations.${INTEGRATION}`);
    expect(err).toBeDefined();
    expect(err!.code).toBe("must_choose_connection");
    expect(err!.candidate_connections!.map((c) => c.id).sort()).toEqual([conn1, conn2].sort());
    // Each candidate reaches the model with what tells it apart, so the retry
    // needs no separate pass over the connection list.
    for (const c of err!.candidate_connections!) {
      expect(c.account_id).toBeTruthy();
      expect(c.owned_by_actor).toBe(true);
      expect(c).toHaveProperty("label");
    }

    // Nothing was launched — the readiness gate ran before run creation.
    expect(await db.select().from(runs)).toHaveLength(0);
  });

  it("launches through the tool when connection_overrides names a candidate, persisting the pick", async () => {
    await seedConnectionTestIntegration(ctx, INTEGRATION);
    await seedDefaultOrgModel(ctx);
    const picked = await seedIntegrationConnection(ctx, INTEGRATION);
    // The second candidate is what makes the resolver ambiguous; the pick must
    // silence it.
    await seedIntegrationConnection(ctx, INTEGRATION);

    const result = await callTool(headers, "run_and_wait", {
      kind: "inline",
      manifest: inlineAgentManifest([INTEGRATION]),
      prompt: "do the thing",
      connection_overrides: { [INTEGRATION]: [picked] },
    });

    // No 409 this time: the tool waited on a real run instead of reporting a
    // launch failure. A launch failure payload is `{ status: <number>, body }`;
    // a launched one is the run projection `{ id, packageId, status, done }`,
    // whose `status` is a run status string. (Which terminal status the fake
    // orchestrator lands on is not this test's business — only that the launch
    // was accepted and the run exists.)
    expect(result.data.body).toBeUndefined();
    expect(typeof result.data.status).toBe("string");
    const runId = result.data.id as string;
    expect(runId).toStartWith("run_");
    expect(result.data.done).toBe(true);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(row).toBeDefined();
    // The audit trail of what the MODEL asked for — this is the field that was
    // silently dropped somewhere between the tool schema and the route.
    expect(row!.connectionOverrides).toEqual({ [INTEGRATION]: [picked] });
    // …and the resolver snapshot the spawn loader + MITM refresh read back,
    // proving the pick was honoured rather than merely stored.
    expect(row!.resolvedConnections).toMatchObject({
      [INTEGRATION]: [{ connectionId: picked, source: "run_override" }],
    });
  }, 60_000);

  // Two ids bind two connections end to end; a layer keeping only the first passes the test above,
  // not this one.
  it("binds every connection the override names, in the run's snapshot", async () => {
    await seedConnectionTestIntegration(ctx, INTEGRATION);
    await seedDefaultOrgModel(ctx);
    const first = await seedIntegrationConnection(ctx, INTEGRATION, { label: "compte-a" });
    const second = await seedIntegrationConnection(ctx, INTEGRATION, { label: "compte-b" });

    const result = await callTool(headers, "run_and_wait", {
      kind: "inline",
      manifest: inlineAgentManifest([INTEGRATION]),
      prompt: "do the thing",
      connection_overrides: { [INTEGRATION]: [first, second] },
    });

    expect(result.data.body).toBeUndefined();
    const runId = result.data.id as string;
    expect(runId).toStartWith("run_");

    const [row] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(row!.connectionOverrides).toEqual({ [INTEGRATION]: [first, second] });
    const resolved = row!.resolvedConnections![INTEGRATION];
    expect(resolved!.map((c) => c.connectionId).sort()).toEqual([first, second].sort());
  }, 60_000);

  // A string where a set belongs is refused (400), never wrapped into a one-element set.
  it("refuses a string where a set belongs, without launching", async () => {
    await seedConnectionTestIntegration(ctx, INTEGRATION);
    await seedDefaultOrgModel(ctx);
    const picked = await seedIntegrationConnection(ctx, INTEGRATION);

    const result = await callTool(headers, "run_and_wait", {
      kind: "inline",
      manifest: inlineAgentManifest([INTEGRATION]),
      prompt: "do the thing",
      connection_overrides: { [INTEGRATION]: picked },
    });

    expect(result.isError).toBe(true);
    expect(result.data.status).toBe(400);
    expect(JSON.stringify(result.data.body)).toContain(INTEGRATION);
    expect(await db.select().from(runs)).toHaveLength(0);
  });

  // `[]` is "use none of them": an optional integration launches unbound, its key kept as `[]` in
  // the snapshot (declared, not inert); a required one is refused before any run exists.
  it("launches with an optional integration bound to none when the override is []", async () => {
    await seedConnectionTestIntegration(ctx, INTEGRATION);
    await seedDefaultOrgModel(ctx);
    await seedIntegrationConnection(ctx, INTEGRATION);
    await seedIntegrationConnection(ctx, INTEGRATION);

    const result = await callTool(headers, "run_and_wait", {
      kind: "inline",
      manifest: inlineAgentManifest([INTEGRATION]),
      prompt: "do the thing",
      connection_overrides: { [INTEGRATION]: [] },
    });

    expect(result.data.body).toBeUndefined();
    const runId = result.data.id as string;
    expect(runId).toStartWith("run_");
    const [row] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(row!.connectionOverrides).toEqual({ [INTEGRATION]: [] });
    expect(row!.resolvedConnections).toEqual({ [INTEGRATION]: [] });
  }, 60_000);

  it("refuses [] for an integration the agent marks required, without launching", async () => {
    await seedConnectionTestIntegration(ctx, INTEGRATION);
    await seedDefaultOrgModel(ctx);
    await seedIntegrationConnection(ctx, INTEGRATION);
    const manifest = inlineAgentManifest([INTEGRATION]);
    (manifest.integrations_configuration as Record<string, Record<string, unknown>>)[
      INTEGRATION
    ]!.required = true;

    const result = await callTool(headers, "run_and_wait", {
      kind: "inline",
      manifest,
      prompt: "do the thing",
      connection_overrides: { [INTEGRATION]: [] },
    });

    expect(result.isError).toBe(true);
    expect(result.data.status).toBe(400);
    expect(JSON.stringify(result.data.body)).toContain(INTEGRATION);
    expect(await db.select().from(runs)).toHaveLength(0);
  });

  // Only the in-process chat (`?context=injected`) renders a link as a card; any other caller,
  // an agent run among them, may persist what the tool returns.
  it("keeps a started run's connect link for the chat only", async () => {
    const OAUTH = "@mcpconn/oauth-svc";
    const manifest = localIntegrationManifest({
      name: OAUTH,
      serverName: `${OAUTH}-server`,
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
    await seedPackage({
      id: OAUTH,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest,
    });
    await seedPackageVersion({ packageId: OAUTH, version: "1.0.0", manifest });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, OAUTH);
    await seedDefaultOrgModel(ctx);

    const warningOf = async (query: string) => {
      const result = await callTool(
        headers,
        "run_and_wait",
        { kind: "inline", manifest: inlineAgentManifest([OAUTH]), prompt: "do the thing" },
        query,
      );
      expect(result.data.done).toBe(true);
      const warnings = result.data.warnings as Array<Record<string, unknown>>;
      return warnings.find((w) => w.field === `integrations.${OAUTH}`)!;
    };

    const chat = await warningOf("?context=injected");
    expect(chat).toMatchObject({ code: "integration_unbound", auth_key: "primary" });
    expect(chat.connect_url).toStartWith("http");

    const external = await warningOf("");
    expect(external).toMatchObject({ code: "integration_unbound", auth_key: "primary" });
    expect(external).not.toHaveProperty("connect_url");
    expect(external).not.toHaveProperty("expiresAt");
  }, 60_000);
});
