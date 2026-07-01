// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { runAndWaitSteps } from "../src/run-and-wait-client.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(
  fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch {
  return fn as unknown as typeof fetch;
}

async function collectSteps(
  fetchImpl: typeof fetch,
  args: Record<string, unknown>,
  opts: { maxMs?: number; backoffMs?: number; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>[]> {
  const steps: Record<string, unknown>[] = [];
  for await (const step of runAndWaitSteps(args, {
    origin: "https://test.local",
    headers: { authorization: "Bearer tok", "x-org-id": "org_1" },
    fetch: fetchImpl,
    ...opts,
  })) {
    steps.push(step.payload);
  }
  return steps;
}

describe("run_and_wait client", () => {
  test("launches an agent run, yields the run id, then yields the terminal run", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const responses = [
      jsonResponse({ id: "run_1", packageId: "@acme/writer", status: "pending" }),
      jsonResponse({ id: "run_1", packageId: "@acme/writer", status: "success" }),
    ];
    const fetchImpl = fakeFetch(async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const res = responses.shift();
      if (!res) throw new Error("unexpected fetch");
      return res;
    });

    await expect(
      collectSteps(fetchImpl, {
        kind: "agent",
        scope: "@acme",
        name: "writer",
        input: { topic: "x" },
      }),
    ).resolves.toEqual([
      { id: "run_1", packageId: "@acme/writer", status: "pending", done: false },
      { id: "run_1", packageId: "@acme/writer", status: "success", done: true },
    ]);
    expect(calls).toMatchObject([
      {
        url: "https://test.local/api/agents/%40acme/writer/run",
        method: "POST",
        body: { input: { topic: "x" } },
      },
      { url: "https://test.local/api/runs/run_1?wait=55", method: "GET" },
    ]);
  });

  test("projects the terminal run onto the documented payload (no metrics leak)", async () => {
    const responses = [
      jsonResponse({ id: "run_1", packageId: "@acme/writer", status: "pending" }),
      jsonResponse({
        id: "run_1",
        packageId: "@acme/writer",
        status: "failed",
        error: "Gmail token expired",
        // Operational fields the model must never see (it quotes them back):
        cost: 0.42,
        tokenUsage: { input: 1200, output: 300 },
        startedAt: "2026-07-01T09:00:00.000Z",
        completedAt: "2026-07-01T09:01:30.000Z",
        config: { secret: "echo" },
        result: { summary: "partial" },
      }),
    ];
    const fetchImpl = fakeFetch(async () => {
      const res = responses.shift();
      if (!res) throw new Error("unexpected fetch");
      return res;
    });

    await expect(
      collectSteps(fetchImpl, { kind: "agent", scope: "@acme", name: "writer" }),
    ).resolves.toEqual([
      { id: "run_1", packageId: "@acme/writer", status: "pending", done: false },
      {
        id: "run_1",
        packageId: "@acme/writer",
        status: "failed",
        done: true,
        result: { summary: "partial" },
        error: "Gmail token expired",
      },
    ]);
  });

  test("validates before dispatching", async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error("should not fetch");
    });

    await expect(collectSteps(fetchImpl, { kind: "inline" })).resolves.toEqual([
      { error: "`manifest` is required for kind:'inline'." },
    ]);
  });

  test("returns a bounded timeout payload", async () => {
    const fetchImpl = fakeFetch(async () =>
      jsonResponse({ id: "run_1", packageId: "@acme/writer", status: "pending" }),
    );

    await expect(
      collectSteps(fetchImpl, { kind: "agent", scope: "@acme", name: "writer" }, { maxMs: 0 }),
    ).resolves.toEqual([
      { id: "run_1", packageId: "@acme/writer", status: "pending", done: false },
      {
        id: "run_1",
        packageId: "@acme/writer",
        status: "pending",
        done: false,
        error: "run_and_wait timed out before the run reached a terminal status.",
      },
    ]);
  });

  test("does not let an in-flight long poll overrun the wait budget", async () => {
    const calls: string[] = [];
    const fetchImpl = fakeFetch(async (input, init) => {
      calls.push(String(input));
      if (String(input).endsWith("/run")) {
        return jsonResponse({ id: "run_1", packageId: "@acme/writer", status: "pending" });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    });

    await expect(
      collectSteps(
        fetchImpl,
        { kind: "agent", scope: "@acme", name: "writer" },
        { maxMs: 5, backoffMs: 0 },
      ),
    ).resolves.toEqual([
      { id: "run_1", packageId: "@acme/writer", status: "pending", done: false },
      {
        id: "run_1",
        packageId: "@acme/writer",
        status: "pending",
        done: false,
        error: "run_and_wait timed out before the run reached a terminal status.",
      },
    ]);
    expect(calls).toEqual([
      "https://test.local/api/agents/%40acme/writer/run",
      "https://test.local/api/runs/run_1?wait=0",
    ]);
  });

  test("honors abort before dispatching", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const fetchImpl = fakeFetch(async () => {
      throw new Error("should not fetch");
    });

    await expect(
      collectSteps(
        fetchImpl,
        { kind: "agent", scope: "@acme", name: "writer" },
        {
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow("stop");
  });
});
