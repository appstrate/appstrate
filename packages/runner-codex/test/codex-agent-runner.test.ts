// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { CodexAgentRunner, type CodexChild } from "../src/codex-agent-runner.ts";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import type { RunResult } from "@appstrate/afps-runtime/runner";

/** A ReadableStream emitting the given NDJSON lines then closing. */
function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line + "\n"));
      controller.close();
    },
  });
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

/** Capturing EventSink. */
function makeSink() {
  const events: RunEvent[] = [];
  let result: RunResult | undefined;
  return {
    events,
    get result() {
      return result;
    },
    sink: {
      async handle(e: RunEvent) {
        events.push(e);
      },
      async finalize(r: RunResult) {
        result = r;
      },
    },
  };
}

const ctx = { runId: "run_1", input: "do the thing", memories: [], config: {} };
// The runner ignores the bundle; a minimal stub satisfies the type at runtime.
const bundle = {} as never;

function vendFetch(body: { access_token: string; account_id?: string | null }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("CodexAgentRunner.run", () => {
  it("vends the token, maps the stream, and finalizes success", async () => {
    let spawnedCmd: string[] | undefined;
    let spawnedEnv: Record<string, string> | undefined;
    const child: CodexChild = {
      stdout: ndjsonStream([
        JSON.stringify({ type: "thread.started", thread_id: "t1" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 2 },
        }),
      ]),
      stderr: emptyStream(),
      exited: Promise.resolve(0),
      kill() {},
    };

    const h = makeSink();
    const runner = new CodexAgentRunner({
      binaryPath: "/fake/codex",
      modelId: "gpt-5.5",
      systemPrompt: "You are a test agent.",
      credentialUrl: "http://sidecar:8080/credential-vend",
      cwd: "/workspace",
      modelCost: { input: 1, output: 2 },
      fetchFn: vendFetch({ access_token: "tok-real", account_id: "acct-1" }),
      spawn: (cmd, opts) => {
        spawnedCmd = cmd;
        spawnedEnv = opts.env;
        return child;
      },
      now: () => 1_700_000_000_000,
    });

    await runner.run({ bundle, context: ctx, eventSink: h.sink });

    // Spawned the official binary with the ToS-clean headless flags.
    expect(spawnedCmd).toEqual([
      "/fake/codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "gpt-5.5",
      "You are a test agent.\n\n---\n\ndo the thing",
    ]);
    // CODEX_HOME points at the ephemeral dir holding the vended auth.json.
    expect(spawnedEnv?.CODEX_HOME).toBeDefined();

    // Mapped the assistant message + metric.
    expect(h.events.some((e) => e.type === "appstrate.progress" && e.message === "done")).toBe(
      true,
    );

    // Terminal verdict: success, with usage + equivalent cost (10*1 + 5*2)/1e6.
    expect(h.result?.status).toBe("success");
    expect(h.result?.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
    });
    expect(h.result?.cost).toBeCloseTo((10 * 1 + 5 * 2) / 1_000_000, 9);
  });

  it("fails the run when a turn.failed is seen, even on a clean exit", async () => {
    const child: CodexChild = {
      stdout: ndjsonStream([JSON.stringify({ type: "turn.failed", error: { message: "nope" } })]),
      stderr: emptyStream(),
      exited: Promise.resolve(0),
      kill() {},
    };
    const h = makeSink();
    const runner = new CodexAgentRunner({
      binaryPath: "/fake/codex",
      modelId: "gpt-5.5",
      systemPrompt: "",
      credentialUrl: "http://sidecar:8080/credential-vend",
      cwd: "/workspace",
      fetchFn: vendFetch({ access_token: "tok" }),
      spawn: () => child,
    });
    await runner.run({ bundle, context: ctx, eventSink: h.sink });
    expect(h.result?.status).toBe("failed");
    expect(h.result?.error?.message).toBe("nope");
  });

  it("fails with the credential error when the vend endpoint returns 410", async () => {
    const h = makeSink();
    let spawned = false;
    const runner = new CodexAgentRunner({
      binaryPath: "/fake/codex",
      modelId: "gpt-5.5",
      systemPrompt: "",
      credentialUrl: "http://sidecar:8080/credential-vend",
      cwd: "/workspace",
      fetchFn: (async () => new Response("{}", { status: 410 })) as unknown as typeof fetch,
      spawn: () => {
        spawned = true;
        return {} as CodexChild;
      },
    });
    await runner.run({ bundle, context: ctx, eventSink: h.sink });
    expect(spawned).toBe(false); // never reached spawn
    expect(h.result?.status).toBe("failed");
    expect(h.result?.error?.message).toMatch(/reconnection/i);
  });

  it("fails with the exit code when the process exits non-zero with no error event", async () => {
    const child: CodexChild = {
      stdout: ndjsonStream([
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
      ]),
      stderr: ndjsonStream(["boom on stderr"]),
      exited: Promise.resolve(3),
      kill() {},
    };
    const h = makeSink();
    const runner = new CodexAgentRunner({
      binaryPath: "/fake/codex",
      modelId: "gpt-5.5",
      systemPrompt: "",
      credentialUrl: "http://sidecar:8080/credential-vend",
      cwd: "/workspace",
      fetchFn: vendFetch({ access_token: "tok" }),
      spawn: () => child,
    });
    await runner.run({ bundle, context: ctx, eventSink: h.sink });
    expect(h.result?.status).toBe("failed");
    expect(h.result?.error?.message).toMatch(/exited with code 3/);
  });
});
