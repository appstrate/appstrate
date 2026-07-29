// SPDX-License-Identifier: Apache-2.0

/**
 * MCP `run_and_wait` × `connection_overrides` — the joined seam.
 *
 * An org with two connections on one integration auth makes run readiness answer
 * `412 missing_integration_connection` / `must_choose_connection`, and the only
 * documented way out is retrying with a `connection_overrides` map. That remedy
 * crosses TWO layers, and it was broken in both at once:
 *
 *   - the MCP tool did not declare the argument and the shared launch client
 *     did not put it in the launch body (unit-covered in
 *     `packages/core/test/run-and-wait-client.test.ts` + this module's
 *     `test/unit/run-and-wait.test.ts`);
 *   - `POST /api/runs/inline` stripped the field and never handed it to the
 *     readiness resolver (covered in
 *     `apps/api/test/integration/routes/inline-run-412-missing-connection.test.ts`).
 *
 * Each side is now pinned in isolation, and isolation is exactly what let the
 * bug ship: either half could regress — a dropped tool property, a renamed wire
 * field — with both suites still green. This file is the one place where the
 * whole chain runs: a real MCP `tools/call` over the real router, the real
 * in-process dispatch, the real inline route, the real DB.
 *
 * Both directions live here on purpose. The 412 is what makes the override
 * necessary and the override is what makes the 412 escapable; asserting them
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
import { setPlatformApp } from "../../../../lib/platform-app.ts";
import { resetCatalog } from "../../catalog.ts";

const app = getTestApp();
// Wire in-process dispatch to the test app — without it `run_and_wait` has no
// platform to launch the run against (production sets this in
// registerModuleRoutes; the test harness mounts modules inline).
setPlatformApp(app);

const MCP_ACCEPT = "application/json, text/event-stream";
const INTEGRATION = "@mcpconn/svc";

interface JsonRpcEnvelope {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Call an MCP tool on the caller's per-org endpoint and parse its JSON payload. */
async function callTool(
  headers: Record<string, string>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; data: Record<string, unknown> }> {
  const res = await app.request(`/api/mcp/o/${headers["X-Org-Id"]}`, {
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
  candidate_connection_ids?: string[];
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
    resetCatalog();
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

  it("returns the 412 must_choose_connection payload through the tool when no pick is given", async () => {
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
    // the code and the candidate ids to build the retry.
    expect(result.data.status).toBe(412);
    const body = result.data.body as ProblemDetails;
    expect(body.code).toBe("missing_integration_connection");
    const err = body.errors!.find((e) => e.field === `integrations.${INTEGRATION}`);
    expect(err).toBeDefined();
    expect(err!.code).toBe("must_choose_connection");
    expect(err!.candidate_connection_ids!.sort()).toEqual([conn1, conn2].sort());

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
      connection_overrides: { [INTEGRATION]: picked },
    });

    // No 412 this time: the tool waited on a real run instead of reporting a
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
    expect(row!.connectionOverrides).toEqual({ [INTEGRATION]: picked });
    // …and the resolver snapshot the spawn loader + MITM refresh read back,
    // proving the pick was honoured rather than merely stored.
    expect(row!.resolvedConnections).toMatchObject({
      [INTEGRATION]: { connectionId: picked },
    });
  }, 60_000);
});
