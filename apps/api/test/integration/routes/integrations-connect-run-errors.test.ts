// SPDX-License-Identifier: Apache-2.0
/**
 * Failure legibility of the connect-run substrate AT THE ROUTE BOUNDARY.
 *
 * Both connect surfaces —
 *   - `POST /api/integrations/{packageId}/auths/{authKey}/connect/fields` (member,
 *     programmatic), and
 *   - `POST /api/integrations/connect/submit` (the HOSTED end-user form, reachable
 *     by someone who is not a member of the organization)
 * — reach `OrchestratedStrategy` → `ConnectRunExecutor`, whose failures used to
 * collapse into one opaque `500 / internal_error / "An internal error occurred"`.
 * The unit suite covers the thrown shapes; this suite proves the shapes actually
 * survive the routes' `if (err instanceof ApiError) throw err;` passthrough and
 * come out of the HTTP boundary with the right status, message — and, for the
 * hosted form, WITHOUT operator- or sidecar-internal detail.
 *
 * The real `createConnectRunExecutor()` runs: only the orchestrator singleton is
 * swapped for a fake that emits the sidecar's stdout sentinels verbatim.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
  connectToolBlock,
  mcpServerManifest,
} from "../../helpers/integration-manifests.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";
import {
  registerOrchestrator,
  _resetOrchestratorRegistryForTesting,
} from "../../../src/services/orchestrator/registry.ts";
import { _resetCacheForTesting } from "@appstrate/env";
import type {
  RunOrchestrator,
  IsolationBoundary,
  WorkloadHandle,
} from "@appstrate/core/platform-types";
import type { IntegrationManifest } from "@appstrate/core/integration";

const app = getTestApp();

const INTEGRATION_ID = "@myorg/portal";
const SERVER_ID = "@myorg/portal-server";

/** A `custom` auth whose connect is a `runAt: "link"` connect.tool → OrchestratedStrategy. */
function connectToolManifest(): IntegrationManifest {
  return localIntegrationManifest({
    name: INTEGRATION_ID,
    displayName: "Portal",
    serverName: SERVER_ID,
    auths: {
      session: {
        type: "custom",
        authorizedUris: ["https://portal.example.test/**"],
        credentialFields: ["email", "password"],
        connect: connectToolBlock({ tool: "login", runAt: "link", produces: ["session_token"] }),
        delivery: httpHeaderDelivery({
          name: "Authorization",
          prefix: "Bearer ",
          field: "session_token",
        }),
      },
    },
  });
}

/**
 * Orchestrator fake that boots "a sidecar" which writes `stdoutLines` and exits.
 * Only the members `ConnectRunExecutor` touches are implemented.
 */
function sentinelOrchestrator(stdoutLines: string[]): RunOrchestrator {
  const orch: Partial<RunOrchestrator> = {
    async createIsolationBoundary(runId: string): Promise<IsolationBoundary> {
      return {
        id: `net-${runId}`,
        name: `net-${runId}`,
        workspace: { kind: "directory", path: `/tmp/test-ws-${runId}` },
        sidecarEndpoints: {
          sidecarUrl: "http://sidecar:8080",
          llmProxyUrl: "http://sidecar:8080/llm",
          forwardProxyUrl: "http://sidecar:8081",
          noProxy: "sidecar,localhost,127.0.0.1",
        },
      };
    },
    async createSidecar(runId: string): Promise<WorkloadHandle> {
      return { id: `sc-${runId}`, runId, role: "sidecar" };
    },
    async startWorkload(): Promise<void> {},
    async stopWorkload(): Promise<void> {},
    async removeWorkload(): Promise<void> {},
    async removeIsolationBoundary(): Promise<void> {},
    async waitForExit(): Promise<number> {
      return 1;
    },
    async *streamLogs(): AsyncGenerator<string> {
      for (const line of stdoutLines) yield line;
    },
  };
  return orch as RunOrchestrator;
}

interface ProblemBody {
  status: number;
  code: string;
  detail: string;
  param?: string;
}

/** Drive the hosted portal end to end: mint → dispatch → context → submit. */
async function hostedSubmit(
  ctx: TestContext,
  credentials: Record<string, unknown>,
): Promise<Response> {
  const mint = await app.request(
    `/api/integrations/${INTEGRATION_ID}/auths/session/connect/session`,
    {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  expect(mint.status).toBe(200);
  const token = new URL(((await mint.json()) as { connect_url: string }).connect_url).searchParams
    .get("token")!
    .toString();

  const start = await app.request(
    `/api/integrations/connect/start?token=${encodeURIComponent(token)}`,
    { redirect: "manual" },
  );
  const cookie = `appstrate_connect=${start.headers.get("set-cookie")!.match(/appstrate_connect=([^;]+)/)![1]}`;
  const context = (await (
    await app.request("/api/integrations/connect/context", { headers: { Cookie: cookie } })
  ).json()) as { csrf: string };

  return app.request("/api/integrations/connect/submit", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "x-connect-csrf": context.csrf },
    body: JSON.stringify({ credentials }),
  });
}

async function fieldsConnect(ctx: TestContext): Promise<Response> {
  return app.request(`/api/integrations/${INTEGRATION_ID}/auths/session/connect/fields`, {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify({ credentials: { email: "a@b.c", password: "pw" } }),
  });
}

describe("connect-run failures at the route boundary", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: connectToolManifest(),
    });
    // The local source references a separate mcp-server package; the launcher
    // resolves its runnable server config before it can spawn anything.
    await seedPackage({
      id: SERVER_ID,
      orgId: ctx.orgId,
      type: "mcp-server",
      source: "local",
      draftManifest: mcpServerManifest({ name: SERVER_ID }),
    });
  });

  afterEach(() => {
    _setOrchestratorForTesting(null);
  });

  it("surfaces a login-tool rejection to the member flow as a 400 naming cause and remedy", async () => {
    _setOrchestratorForTesting(
      sentinelOrchestrator([
        "APPSTRATE_CONNECT_ERROR:connect-login: login tool reported an error: MFA code required",
      ]),
    );

    const res = await fieldsConnect(ctx);

    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    expect(body.detail).toContain("MFA code required");
    expect(body.detail).toContain("Check the credentials you submitted");
    expect(body.param).toBe("credentials");
  });

  it("surfaces a login-tool rejection to the HOSTED end-user form as a 400 with the same diagnostic", async () => {
    _setOrchestratorForTesting(
      sentinelOrchestrator([
        "APPSTRATE_CONNECT_ERROR:connect-login: login tool reported an error: Wrong password",
      ]),
    );

    const res = await hostedSubmit(ctx, { email: "a@b.c", password: "nope" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    // The end user's own credential problem — safe to tell them, and the only
    // thing that makes the hosted form actionable.
    expect(body.detail).toContain("Wrong password");
  });

  it("keeps a sidecar-internal failure a generic 500 that leaks no internals", async () => {
    // A runner-spawn fault lands on the SAME stdout sentinel as the login
    // diagnostic, but its text carries namespaces / host paths / env-var names.
    _setOrchestratorForTesting(
      sentinelOrchestrator([
        "APPSTRATE_CONNECT_ERROR:runConnectOnce: spec has no manifest.server to spawn (/tmp/afps-ca-connect-9f2/ca.pem, CONNECT_RESULT_KEY)",
      ]),
    );

    const res = await fieldsConnect(ctx);

    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(JSON.parse(raw).detail).toBe("An internal error occurred");
    for (const internal of [
      "runConnectOnce",
      "manifest.server",
      "/tmp/afps-ca-connect",
      "CONNECT_RESULT_KEY",
    ]) {
      expect(raw).not.toContain(internal);
    }
  });

  it("returns the hosted form a generic 503 when the backend cannot host connect-runs — no operator config leaked", async () => {
    // The capability gate fires on the GLOBAL backend, before any boundary
    // exists. Its remedy (`RUN_ADAPTER=docker`) is operator-facing deployment
    // configuration and must stay in the logs, not in an end user's browser.
    const prevAdapter = process.env.RUN_ADAPTER;
    process.env.RUN_ADAPTER = "fake-vm";
    registerOrchestrator(
      "fake-vm",
      { isolatesWorkloads: true, supportsSidecarOnly: false, create: () => ({}) as never },
      "test",
    );
    _resetCacheForTesting();
    try {
      const res = await hostedSubmit(ctx, { email: "a@b.c", password: "pw" });

      expect(res.status).toBe(503);
      const raw = await res.text();
      const body = JSON.parse(raw) as ProblemBody;
      expect(body.code).toBe("connect_unavailable");
      expect(body.detail).toContain("unavailable");
      for (const operatorDetail of ["RUN_ADAPTER", "fake-vm", "sidecar"]) {
        expect(raw).not.toContain(operatorDetail);
      }
    } finally {
      if (prevAdapter === undefined) delete process.env.RUN_ADAPTER;
      else process.env.RUN_ADAPTER = prevAdapter;
      _resetOrchestratorRegistryForTesting();
      _resetCacheForTesting();
    }
  });
});
