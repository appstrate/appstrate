// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  fetchRunDocuments,
  launchRunAndWait,
  runAndWaitSteps,
  runAndWaitStepsWithDocuments,
} from "../src/run-and-wait-client.ts";

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
        url: "https://test.local/api/agents/@acme/writer/run",
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

  test("rejects an inline run without a top-level prompt before dispatching", async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error("should not fetch");
    });

    const steps = await collectSteps(fetchImpl, { kind: "inline", manifest: { name: "tmp" } });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.error).toContain("top-level argument");
  });

  test("tells the caller to move a prompt nested inside the manifest", async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error("should not fetch");
    });

    const steps = await collectSteps(fetchImpl, {
      kind: "inline",
      manifest: { name: "tmp", prompt: "do it" },
    });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.error).toContain("found inside `manifest`");
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
      "https://test.local/api/agents/@acme/writer/run",
      "https://test.local/api/runs/run_1?wait=0",
    ]);
  });

  test("enriches the terminal step with the run's published documents", async () => {
    const fetchImpl = fakeFetch(async (input) => {
      const url = String(input);
      if (url.endsWith("/run")) {
        return jsonResponse({ id: "run_1", packageId: "@acme/writer", status: "pending" });
      }
      if (url.includes("/api/documents")) {
        return jsonResponse({
          object: "list",
          data: [
            {
              id: "doc_1",
              uri: "document://doc_1",
              name: "report.html",
              mime: "text/html",
              size: 2048,
              purpose: "agent_output",
            },
          ],
          hasMore: false,
        });
      }
      // GET /api/runs/run_1?wait=…
      return jsonResponse({ id: "run_1", packageId: "@acme/writer", status: "success" });
    });

    const steps: Record<string, unknown>[] = [];
    for await (const step of runAndWaitStepsWithDocuments(
      { kind: "agent", scope: "@acme", name: "writer" },
      { origin: "https://test.local", headers: { authorization: "Bearer tok" }, fetch: fetchImpl },
    )) {
      steps.push(step.payload);
    }

    expect(steps[0]).toEqual({
      id: "run_1",
      packageId: "@acme/writer",
      status: "pending",
      done: false,
    });
    expect(steps[1]).toEqual({
      id: "run_1",
      packageId: "@acme/writer",
      status: "success",
      done: true,
      documents: [
        {
          id: "doc_1",
          uri: "document://doc_1",
          name: "report.html",
          mime: "text/html",
          size: 2048,
        },
      ],
    });
  });

  test("leaves the payload document-free when the run published none", async () => {
    const fetchImpl = fakeFetch(async (input) => {
      const url = String(input);
      if (url.endsWith("/run")) {
        return jsonResponse({ id: "run_1", packageId: "@acme/writer", status: "pending" });
      }
      if (url.includes("/api/documents")) {
        return jsonResponse({ object: "list", data: [], hasMore: false });
      }
      return jsonResponse({ id: "run_1", packageId: "@acme/writer", status: "success" });
    });

    const steps: Record<string, unknown>[] = [];
    for await (const step of runAndWaitStepsWithDocuments(
      { kind: "agent", scope: "@acme", name: "writer" },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    )) {
      steps.push(step.payload);
    }
    expect(steps[1]).not.toHaveProperty("documents");
  });

  test("fetchRunDocuments swallows a non-2xx response", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ error: "nope" }, 500));
    await expect(
      fetchRunDocuments("run_1", {
        origin: "https://test.local",
        headers: {},
        fetch: fetchImpl,
      }),
    ).resolves.toEqual([]);
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

describe("launchRunAndWait launch body", () => {
  function captureLaunch(): {
    fetchImpl: typeof fetch;
    captured: () => { url: string; method: string; body: unknown } | undefined;
  } {
    let seen: { url: string; method: string; body: unknown } | undefined;
    const fetchImpl = fakeFetch(async (input, init) => {
      seen = {
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      return jsonResponse({ id: "run_1", status: "pending" });
    });
    return { fetchImpl, captured: () => seen };
  }

  test("kind:inline forwards manifest, prompt, input, and config", async () => {
    const { fetchImpl, captured } = captureLaunch();

    const result = await launchRunAndWait(
      {
        kind: "inline",
        manifest: { name: "tmp" },
        prompt: "do it",
        input: { screenshot: "document://doc_abc12345" },
        config: { model: "x" },
      },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect(captured()).toMatchObject({
      url: "https://test.local/api/runs/inline",
      method: "POST",
      body: {
        manifest: { name: "tmp" },
        prompt: "do it",
        input: { screenshot: "document://doc_abc12345" },
        config: { model: "x" },
      },
    });
  });

  test("kind:inline omits input when none is provided", async () => {
    const { fetchImpl, captured } = captureLaunch();

    await launchRunAndWait(
      { kind: "inline", manifest: { name: "tmp" }, prompt: "do it" },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    );

    expect(captured()?.body).toEqual({ manifest: { name: "tmp" }, prompt: "do it" });
  });

  test("kind:agent forwards input in the launch body", async () => {
    const { fetchImpl, captured } = captureLaunch();

    await launchRunAndWait(
      { kind: "agent", scope: "@acme", name: "writer", input: { topic: "x" } },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    );

    expect(captured()).toMatchObject({
      url: "https://test.local/api/agents/@acme/writer/run",
      method: "POST",
      body: { input: { topic: "x" } },
    });
  });

  test("exposes the launch HTTP status on success", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ id: "run_1", status: "pending" }, 201));

    const result = await launchRunAndWait(
      { kind: "inline", manifest: { name: "tmp" }, prompt: "do it" },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    );

    expect(result).toMatchObject({ ok: true, launchStatus: 201 });
  });
});
