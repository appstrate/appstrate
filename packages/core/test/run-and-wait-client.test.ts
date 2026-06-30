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
      { url: "https://test.local/api/runs/run_1?wait=true", method: "GET" },
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
