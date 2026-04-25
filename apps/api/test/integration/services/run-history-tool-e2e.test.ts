// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end test of the `run_history` tool contract across all three
 * layers:
 *
 *   agent → Pi tool (run_history)
 *          → createSidecarRunHistoryCall
 *          → sidecar createApp() /run-history
 *          → platform getTestApp() /internal/run-history
 *          → DB
 *
 * Every layer is composed from its production source — no component is
 * mocked. The only plumbing is a pair of fetch shims that route HTTP
 * requests between the in-process instances (no ports bound).
 *
 * What this test guarantees that layer-isolated tests cannot:
 *   - Header contract between client → sidecar → platform is correct
 *     (`Authorization: Bearer <runToken>`)
 *   - Query parameter contract (`limit`, `fields`) survives every hop
 *   - Response shape (`{ runs: [...] }`) is preserved byte-for-byte
 *   - Zero-knowledge invariant: nothing in the agent-visible response
 *     leaks the sidecar URL or the run token
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { RunEvent } from "@appstrate/afps-runtime/resolvers";
import { buildRunHistoryExtensionFactory } from "@appstrate/runner-pi";

import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { signRunToken } from "../../../src/lib/run-token.ts";
import { createApp as createSidecarApp } from "../../../../../runtime-pi/sidecar/app.ts";

const PLATFORM_ORIGIN = "http://platform.internal";
const SIDECAR_ORIGIN = "http://sidecar.internal";

/**
 * Wire platform ↔ sidecar ↔ client as in-process Hono apps. Requests
 * from the sidecar to the platform (`fetchFn`) and from the client to
 * the sidecar (`fetch`) are routed through Hono's `app.request` instead
 * of the network — no ports, no TCP, same HTTP semantics.
 */
function composeE2E(platformApp: ReturnType<typeof getTestApp>, runToken: string) {
  const sidecarApp = createSidecarApp({
    config: {
      platformApiUrl: PLATFORM_ORIGIN,
      runToken,
      proxyUrl: "",
    },
    fetchCredentials: async () => {
      throw new Error("not used in this test");
    },
    cookieJar: new Map(),
    // Route every outbound sidecar → platform call to the in-process
    // platform app. Strip the PLATFORM_ORIGIN prefix so Hono matches
    // the path against its route table.
    fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
      const full = typeof url === "string" ? url : url.toString();
      const parsed = new URL(full);
      if (parsed.origin !== PLATFORM_ORIGIN) {
        throw new Error(`unexpected outbound URL from sidecar: ${full}`);
      }
      return platformApp.request(`${parsed.pathname}${parsed.search}`, init);
    }) as unknown as typeof fetch,
  });

  // Route every client → sidecar call to the in-process sidecar app.
  const clientFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const full = typeof url === "string" ? url : url.toString();
    const parsed = new URL(full);
    if (parsed.origin !== SIDECAR_ORIGIN) {
      throw new Error(`unexpected outbound URL from client: ${full}`);
    }
    return sidecarApp.request(`${parsed.pathname}${parsed.search}`, init);
  }) as unknown as typeof fetch;

  return { clientFetch };
}

function makeFakePi(): {
  api: ExtensionAPI;
  tools: Array<{
    name: string;
    parameters: unknown;
    execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
  }>;
} {
  const tools: Array<{
    name: string;
    parameters: unknown;
    execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
  }> = [];
  const api = {
    registerTool(tool: (typeof tools)[number]) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  return { api, tools };
}

const platformApp = getTestApp();

describe("run_history — end-to-end (Pi tool → sidecar → platform → DB)", () => {
  let ctx: TestContext;
  let pkgId: string;
  let runningRunId: string;
  let runningToken: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "runhistorye2e" });
    pkgId = "@runhistorye2e/agent";

    await seedAgent({
      id: pkgId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });

    // Seed 3 completed runs to fetch from the tool. Duration is
    // required by the strict client validator — matches production
    // where every terminal run has a duration recorded.
    // Note: the platform filters to status=success in getRecentRuns, so
    // the "failed" run below is intentional noise that must NOT appear.
    await seedRun({
      packageId: pkgId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      dashboardUserId: ctx.user.id,
      status: "success",
      duration: 1000,
      state: { turn: 1 },
    });
    await seedRun({
      packageId: pkgId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      dashboardUserId: ctx.user.id,
      status: "success",
      duration: 2000,
      state: { turn: 2 },
    });
    await seedRun({
      packageId: pkgId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      dashboardUserId: ctx.user.id,
      status: "success",
      duration: 3000,
      state: { turn: 3 },
    });
    // Plus one failed run that should be excluded by the platform filter.
    await seedRun({
      packageId: pkgId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      dashboardUserId: ctx.user.id,
      status: "failed",
      duration: 500,
      state: { turn: 99 },
    });

    const running = await seedRun({
      packageId: pkgId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      dashboardUserId: ctx.user.id,
      status: "running",
    });
    runningRunId = running.id;
    runningToken = signRunToken(runningRunId);
  });

  it("returns prior runs through the full stack with no layer mocked", async () => {
    const { clientFetch } = composeE2E(platformApp, runningToken);
    const events: RunEvent[] = [];

    const factory = buildRunHistoryExtensionFactory({
      sidecarUrl: SIDECAR_ORIGIN,
      runId: runningRunId,
      workspace: "/tmp",
      emit: (e) => events.push(e),
      transport: { fetch: clientFetch },
    });
    const pi = makeFakePi();
    factory(pi.api);
    expect(pi.tools).toHaveLength(1);
    expect(pi.tools[0]!.name).toBe("run_history");

    const result = await pi.tools[0]!.execute(
      "call_1",
      { limit: 2, fields: ["checkpoint"] },
      undefined,
    );

    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content).toHaveLength(1);
    const body = JSON.parse(content[0]!.text) as {
      runs: Array<{
        id: string;
        status: string;
        date: string;
        duration: number;
        checkpoint?: unknown;
      }>;
    };

    expect(body.runs).toHaveLength(2);
    for (const entry of body.runs) {
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.date).toBe("string");
      expect(typeof entry.duration).toBe("number");
      expect(entry).toHaveProperty("checkpoint");
      // Current run excluded
      expect(entry.id).not.toBe(runningRunId);
    }
  });

  it("emits run_history.called with the observed count from the platform", async () => {
    const { clientFetch } = composeE2E(platformApp, runningToken);
    const events: RunEvent[] = [];

    const factory = buildRunHistoryExtensionFactory({
      sidecarUrl: SIDECAR_ORIGIN,
      runId: runningRunId,
      workspace: "/tmp",
      emit: (e) => events.push(e),
      transport: { fetch: clientFetch },
    });
    const pi = makeFakePi();
    factory(pi.api);

    await pi.tools[0]!.execute(
      "call_2",
      { limit: 50, fields: ["checkpoint", "result"] },
      undefined,
    );

    const called = events.find((e) => e.type === "run_history.called");
    expect(called).toBeDefined();
    expect(called!.status).toBe("success");
    expect(called!.count).toBe(3);
    expect(called!.limit).toBe(50);
    expect(called!.fields).toEqual(["checkpoint", "result"]);
  });

  it("does not leak sidecar URL or run token through the tool response", async () => {
    const { clientFetch } = composeE2E(platformApp, runningToken);

    const factory = buildRunHistoryExtensionFactory({
      sidecarUrl: SIDECAR_ORIGIN,
      runId: runningRunId,
      workspace: "/tmp",
      emit: () => {},
      transport: { fetch: clientFetch },
    });
    const pi = makeFakePi();
    factory(pi.api);

    const result = await pi.tools[0]!.execute("call_3", {}, undefined);
    const payload = JSON.stringify(result);
    expect(payload).not.toContain(SIDECAR_ORIGIN);
    expect(payload).not.toContain(PLATFORM_ORIGIN);
    expect(payload).not.toContain(runningToken);
    expect(payload).not.toContain("Authorization");
    expect(payload).not.toContain("Bearer");
  });

  it("propagates platform errors as structured tool errors (no fallback data)", async () => {
    // Use a forged token — the platform will 401 the sidecar; the
    // sidecar surfaces the HTTP status transparently, and the client
    // throws a contextual error.
    const { clientFetch } = composeE2E(platformApp, "not-a-real-token");

    const factory = buildRunHistoryExtensionFactory({
      sidecarUrl: SIDECAR_ORIGIN,
      runId: runningRunId,
      workspace: "/tmp",
      emit: () => {},
      transport: { fetch: clientFetch },
    });
    const pi = makeFakePi();
    factory(pi.api);

    await expect(pi.tools[0]!.execute("call_4", {}, undefined)).rejects.toThrow(
      /run_history: sidecar returned HTTP 4\d\d/,
    );
  });
});
