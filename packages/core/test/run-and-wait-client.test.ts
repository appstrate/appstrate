// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  fetchRunDocuments,
  launchRunAndWait,
  runAndWaitSteps,
  runAndWaitStepsWithDocuments,
} from "../src/run-and-wait-client.ts";
import { agentManifestSchema } from "../src/validation.ts";

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
  it("launches an agent run, yields the run id, then yields the terminal run", async () => {
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

  it("projects the terminal run onto the documented payload (no metrics leak)", async () => {
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

  it("validates before dispatching", async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error("should not fetch");
    });

    await expect(collectSteps(fetchImpl, { kind: "inline" })).resolves.toEqual([
      { error: "`manifest` is required for kind:'inline'." },
    ]);
  });

  it("rejects an unparseable agent reference before dispatching", async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error("should not fetch");
    });

    // Scope missing its leading `@` — encodePackageIdPath refuses it; the
    // client must fail fast instead of building a path the routes 404.
    await expect(
      collectSteps(fetchImpl, { kind: "agent", scope: "acme", name: "writer" }),
    ).resolves.toEqual([{ error: "Invalid agent reference: acme/writer (expected @scope/name)." }]);
  });

  it("rejects an inline run without a top-level prompt before dispatching", async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error("should not fetch");
    });

    const steps = await collectSteps(fetchImpl, { kind: "inline", manifest: { name: "tmp" } });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.error).toContain("top-level argument");
  });

  it("tells the caller to move a prompt nested inside the manifest", async () => {
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

  it("returns a bounded timeout payload", async () => {
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

  it("does not let an in-flight long poll overrun the wait budget", async () => {
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

  it("enriches the terminal step with the run's published documents", async () => {
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
              run_id: "run_1",
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

  it("leaves the payload document-free when the run published none", async () => {
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

  it("fetchRunDocuments keeps only documents this run produced", async () => {
    // The documents container of a run also holds the documents mounted as its
    // INPUT — a chained `document://` from an earlier run carries
    // `purpose: 'agent_output'` too, so only its `run_id` distinguishes it.
    const fetchImpl = fakeFetch(async () =>
      jsonResponse({
        object: "list",
        data: [
          {
            id: "doc_in",
            uri: "document://doc_in",
            name: "input.pdf",
            mime: "application/pdf",
            size: 10,
            purpose: "agent_output",
            run_id: "run_0",
          },
          {
            id: "doc_out",
            uri: "document://doc_out",
            name: "report.html",
            mime: "text/html",
            size: 20,
            purpose: "agent_output",
            run_id: "run_1",
          },
          {
            id: "doc_detached",
            uri: "document://doc_detached",
            name: "orphan.txt",
            mime: "text/plain",
            size: 30,
            purpose: "agent_output",
            run_id: null,
          },
        ],
        hasMore: false,
      }),
    );

    await expect(
      fetchRunDocuments("run_1", {
        origin: "https://test.local",
        headers: {},
        fetch: fetchImpl,
      }),
    ).resolves.toEqual([
      {
        id: "doc_out",
        uri: "document://doc_out",
        name: "report.html",
        mime: "text/html",
        size: 20,
      },
    ]);
  });

  it("fetchRunDocuments swallows a non-2xx response", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ error: "nope" }, 500));
    await expect(
      fetchRunDocuments("run_1", {
        origin: "https://test.local",
        headers: {},
        fetch: fetchImpl,
      }),
    ).resolves.toEqual([]);
  });

  it("honors abort before dispatching", async () => {
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
  const defaultInlineManifest = (overrides: Record<string, unknown>) => ({
    $schema: "https://schemas.afps.dev/v0/agent.schema.json",
    schema_version: "0.2",
    type: "agent",
    version: "1.0.0",
    dependencies: {},
    runtime_tools: ["log", "output", "publish_document"],
    output: { schema: { type: "object", properties: {}, additionalProperties: true } },
    ...overrides,
  });

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

  it("kind:inline materializes a minimal manifest and forwards prompt, input, and config", async () => {
    const { fetchImpl, captured } = captureLaunch();

    const result = await launchRunAndWait(
      {
        kind: "inline",
        manifest: { display_name: "Analyse café" },
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
        manifest: defaultInlineManifest({
          name: "@inline/analyse-cafe",
          display_name: "Analyse café",
        }),
        prompt: expect.stringContaining("do it"),
        input: { screenshot: "document://doc_abc12345" },
        config: { model: "x" },
      },
    });
    const body = captured()?.body as { manifest?: unknown } | undefined;
    expect(agentManifestSchema.safeParse(body?.manifest).success).toBe(true);
  });

  it("kind:inline preserves every field of a complete deterministic manifest", async () => {
    const { fetchImpl, captured } = captureLaunch();

    const manifest = {
      $schema: "https://example.test/custom-agent.schema.json",
      schema_version: "0.1",
      name: "@custom/deterministic-report",
      display_name: "Rapport déterministe",
      type: "agent",
      version: "7.3.1",
      description: "Exact caller-owned contract",
      timeout: 42,
      dependencies: { integrations: { "@appstrate/gmail": "^1.2.0" } },
      integrations_configuration: { "@appstrate/gmail": { tools: ["api_call"] } },
      runtime_tools: ["output"],
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["count"],
          properties: { count: { type: "integer" } },
        },
        property_order: ["count"],
      },
      _meta: { "example.test/mode": "strict" },
    };

    const result = await launchRunAndWait(
      {
        kind: "inline",
        manifest,
        prompt: "Write the requested report to outputs/report.html.",
      },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect((captured()?.body as { manifest?: unknown } | undefined)?.manifest).toEqual(manifest);
    expect((captured()?.body as { prompt?: string } | undefined)?.prompt).toBe(
      "Write the requested report to outputs/report.html.",
    );
  });

  it("kind:inline preserves an explicit empty runtime_tools override", async () => {
    const { fetchImpl, captured } = captureLaunch();

    const result = await launchRunAndWait(
      {
        kind: "inline",
        manifest: { display_name: "Effet sans outil", runtime_tools: [] },
        prompt: "Perform the side effect.",
      },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    );

    expect(result.ok).toBe(true);
    const manifest = (captured()?.body as { manifest?: Record<string, unknown> } | undefined)
      ?.manifest;
    expect(manifest?.runtime_tools).toEqual([]);
    expect(manifest).not.toHaveProperty("output");
  });

  it("kind:inline rejects a minimal manifest with no usable identity before dispatch", async () => {
    const { fetchImpl, captured } = captureLaunch();

    const result = await launchRunAndWait(
      { kind: "inline", manifest: { dependencies: {} }, prompt: "do it" },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    );

    expect(result.ok).toBe(false);
    expect(
      String((result as { step: { payload: { error?: string } } }).step.payload.error),
    ).toMatch(/display_name.*name/);
    expect(captured()).toBeUndefined();
  });

  it("kind:inline omits input when none is provided", async () => {
    const { fetchImpl, captured } = captureLaunch();

    await launchRunAndWait(
      { kind: "inline", manifest: { name: "tmp" }, prompt: "do it" },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    );

    expect(captured()?.body).toEqual({
      manifest: defaultInlineManifest({ name: "tmp" }),
      prompt: expect.stringContaining("do it"),
    });
  });

  it("kind:agent forwards input in the launch body", async () => {
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

  it("forwards the top-level modelId override for either run kind", async () => {
    const inline = captureLaunch();
    await launchRunAndWait(
      {
        kind: "inline",
        manifest: { name: "tmp" },
        prompt: "do it",
        modelId: "model_mistral",
      },
      { origin: "https://test.local", headers: {}, fetch: inline.fetchImpl },
    );
    expect(inline.captured()?.body).toMatchObject({ modelId: "model_mistral" });

    const agent = captureLaunch();
    await launchRunAndWait(
      { kind: "agent", scope: "@acme", name: "writer", modelId: "model_mistral" },
      { origin: "https://test.local", headers: {}, fetch: agent.fetchImpl },
    );
    expect(agent.captured()?.body).toMatchObject({ modelId: "model_mistral" });
  });

  // Fan-in by reference: the tool argument has to survive body construction,
  // otherwise the model is told the documents were delivered and nothing is
  // mounted — the silent failure this feature exists to remove.
  it("kind:inline forwards context_documents", async () => {
    const { fetchImpl, captured } = captureLaunch();

    await launchRunAndWait(
      {
        kind: "inline",
        manifest: { name: "tmp" },
        prompt: "compile",
        context_documents: ["document://doc_abc12345", "document://doc_def67890"],
      },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    );

    expect(captured()?.body).toMatchObject({
      context_documents: ["document://doc_abc12345", "document://doc_def67890"],
    });
  });

  it("kind:inline omits an empty context_documents", async () => {
    const { fetchImpl, captured } = captureLaunch();

    await launchRunAndWait(
      {
        kind: "inline",
        manifest: { name: "tmp" },
        prompt: "do it",
        context_documents: [],
      },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    );

    expect(captured()?.body).toEqual({
      manifest: defaultInlineManifest({ name: "tmp" }),
      prompt: expect.stringContaining("do it"),
    });
  });

  it("kind:agent rejects context_documents before dispatch (never silently drops it)", async () => {
    const { fetchImpl, captured } = captureLaunch();

    const result = await launchRunAndWait(
      {
        kind: "agent",
        scope: "@acme",
        name: "writer",
        context_documents: ["document://doc_abc12345"],
      },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    );

    expect(result.ok).toBe(false);
    expect(
      String((result as { step: { payload: { error?: string } } }).step.payload.error),
    ).toMatch(/only supported for kind:'inline'/);
    // No run was launched.
    expect(captured()).toBeUndefined();
  });

  // `connection_overrides` is the documented retry for a 412
  // `must_choose_connection`. Dropped anywhere along the way, every retry hits
  // the same 412 with nothing saying why, and the model has no way out.
  it("kind:inline forwards connection_overrides", async () => {
    const { fetchImpl, captured } = captureLaunch();

    await launchRunAndWait(
      {
        kind: "inline",
        manifest: { name: "tmp" },
        prompt: "do it",
        connection_overrides: { "@appstrate/gmail": "conn_abc" },
      },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    );

    expect(captured()).toMatchObject({
      url: "https://test.local/api/runs/inline",
      method: "POST",
      body: { connection_overrides: { "@appstrate/gmail": "conn_abc" } },
    });
  });

  it("kind:agent forwards connection_overrides", async () => {
    const { fetchImpl, captured } = captureLaunch();

    await launchRunAndWait(
      {
        kind: "agent",
        scope: "@acme",
        name: "writer",
        connection_overrides: { "@appstrate/gmail": "conn_abc" },
      },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    );

    expect(captured()).toMatchObject({
      url: "https://test.local/api/agents/@acme/writer/run",
      method: "POST",
      body: { connection_overrides: { "@appstrate/gmail": "conn_abc" } },
    });
  });

  // Absent and present-but-empty are different requests: an omitted argument
  // leaves the launch body untouched, while `{}` is a well-shaped map and
  // travels like any other rather than being folded back into "no argument".
  it("omits connection_overrides when absent and forwards an empty map when present", async () => {
    const absent = captureLaunch();
    await launchRunAndWait(
      { kind: "inline", manifest: { name: "tmp" }, prompt: "do it" },
      { origin: "https://test.local", headers: {}, fetch: absent.fetchImpl },
    );
    expect(Object.keys(absent.captured()?.body as Record<string, unknown>)).not.toContain(
      "connection_overrides",
    );

    const empty = captureLaunch();
    const result = await launchRunAndWait(
      {
        kind: "inline",
        manifest: { name: "tmp" },
        prompt: "do it",
        connection_overrides: {},
      },
      { origin: "https://test.local", headers: {}, fetch: empty.fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(empty.captured()?.body).toMatchObject({ connection_overrides: {} });
  });

  it("rejects a JSON-encoded connection_overrides string before dispatch", async () => {
    const { fetchImpl, captured } = captureLaunch();

    const result = await launchRunAndWait(
      {
        kind: "inline",
        manifest: { name: "tmp" },
        prompt: "do it",
        connection_overrides: JSON.stringify({ "@appstrate/gmail": "conn_abc" }),
      },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    );

    expect(result.ok).toBe(false);
    expect(
      String((result as { step: { payload: { error?: string } } }).step.payload.error),
    ).toMatch(/must be a JSON object/);
    expect(captured()).toBeUndefined();
  });

  // Presence is what is refused, not one enumerated mistake: every non-object
  // shape reaches the same dead end as the JSON-encoded string above.
  it.each([
    ["an array", [{ "@appstrate/gmail": "conn_abc" }]],
    ["a number", 42],
    ["a boolean", true],
    ["explicit null", null],
  ])("rejects connection_overrides given as %s before dispatch", async (_label, value) => {
    const { fetchImpl, captured } = captureLaunch();

    const result = await launchRunAndWait(
      {
        kind: "inline",
        manifest: { name: "tmp" },
        prompt: "do it",
        connection_overrides: value,
      },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    );

    expect(result.ok).toBe(false);
    expect(
      String((result as { step: { payload: { error?: string } } }).step.payload.error),
    ).toMatch(/must be a JSON object/);
    expect(captured()).toBeUndefined();
  });

  // The name inside `config` belongs to the AGENT, not to us: an agent whose own
  // config schema declares a `connection_overrides` property must stay launchable
  // and get that property through untouched, whatever the top-level argument says.
  it("forwards the top-level connection_overrides and leaves config's own property alone", async () => {
    const { fetchImpl, captured } = captureLaunch();

    const result = await launchRunAndWait(
      {
        kind: "inline",
        manifest: { name: "tmp" },
        prompt: "do it",
        connection_overrides: { "@appstrate/gmail": "conn_top" },
        config: { connection_overrides: { "@appstrate/gmail": "conn_nested" } },
      },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect(captured()?.body).toMatchObject({
      connection_overrides: { "@appstrate/gmail": "conn_top" },
      config: { connection_overrides: { "@appstrate/gmail": "conn_nested" } },
    });
  });

  it("launches an agent whose config declares its own connection_overrides property", async () => {
    const { fetchImpl, captured } = captureLaunch();

    const result = await launchRunAndWait(
      {
        kind: "agent",
        scope: "@acme",
        name: "writer",
        config: { connection_overrides: { "@appstrate/gmail": "conn_abc" } },
      },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    );

    expect(result.ok).toBe(true);
    // Verbatim, and nothing synthesised at top level from it.
    expect(captured()?.body).toMatchObject({
      config: { connection_overrides: { "@appstrate/gmail": "conn_abc" } },
    });
    expect(Object.keys(captured()?.body as Record<string, unknown>)).not.toContain(
      "connection_overrides",
    );
  });

  it("exposes the launch HTTP status on success", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ id: "run_1", status: "pending" }, 201));

    const result = await launchRunAndWait(
      { kind: "inline", manifest: { name: "tmp" }, prompt: "do it" },
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    );

    expect(result).toMatchObject({ ok: true, launchStatus: 201 });
  });
});
