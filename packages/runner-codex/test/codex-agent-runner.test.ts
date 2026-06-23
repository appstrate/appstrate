// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

    // Spawned the official binary with the documented headless flags.
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

  it("succeeds when a transient turn.failed is followed by a turn.completed + clean exit", async () => {
    // Last-turn-authoritative (C7): the CLI hit a recoverable error mid-run,
    // retried, completed, and exited 0 — the run is a success, not a failure.
    const child: CodexChild = {
      stdout: ndjsonStream([
        JSON.stringify({ type: "turn.failed", error: { message: "transient 503" } }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 2 } }),
      ]),
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
    expect(h.result?.status).toBe("success");
    expect(h.result?.error).toBeUndefined();
    expect(h.result?.usage).toMatchObject({ input_tokens: 4, output_tokens: 2 });
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

  it("writes a config.toml pointing codex at the sidecar /mcp when sidecarMcp is set", async () => {
    let configToml: string | undefined;
    const child: CodexChild = {
      stdout: emptyStream(),
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
      sidecarMcp: { url: "http://sidecar:8080/mcp", headers: { Host: "sidecar" } },
      fetchFn: vendFetch({ access_token: "tok" }),
      spawn: (_cmd, opts) => {
        // config.toml is written into CODEX_HOME before spawn.
        configToml = readFileSync(join(opts.env.CODEX_HOME!, "config.toml"), "utf8");
        return child;
      },
    });
    await runner.run({ bundle, context: ctx, eventSink: h.sink });
    expect(configToml).toContain("[mcp_servers.platform]");
    expect(configToml).toContain('url = "http://sidecar:8080/mcp"');
    expect(configToml).toContain("[mcp_servers.platform.http_headers]");
    expect(configToml).toContain('"Host" = "sidecar"');
  });

  it("emits journaled runtime events drained from the sidecar with the run id stamped", async () => {
    // The sidecar executes `log` once and journals `log.written`; the runner
    // drains the journal at a step boundary and re-emits on its single sink.
    const child: CodexChild = {
      stdout: ndjsonStream([
        JSON.stringify({
          type: "item.completed",
          item: { type: "mcp_tool_call", tool: "log", status: "completed" },
        }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
      ]),
      stderr: emptyStream(),
      exited: Promise.resolve(0),
      kill() {},
    };
    let finalDrained = false;
    let yielded = false;
    const drainer = {
      async drain(opts?: { final?: boolean }) {
        if (opts?.final) finalDrained = true;
        if (yielded) return [];
        yielded = true;
        return [{ type: "log.written", level: "info", message: "hello from codex" }] as never;
      },
    };
    const h = makeSink();
    const runner = new CodexAgentRunner({
      binaryPath: "/fake/codex",
      modelId: "gpt-5.5",
      systemPrompt: "",
      credentialUrl: "http://sidecar:8080/credential-vend",
      cwd: "/workspace",
      sidecarMcp: { url: "http://sidecar:8080/mcp" },
      drainer,
      fetchFn: vendFetch({ access_token: "tok" }),
      spawn: () => child,
      now: () => 1_700_000_000_000,
    });
    await runner.run({ bundle, context: ctx, eventSink: h.sink });

    const logged = h.events.find((e) => e.type === "log.written") as
      | (RunEvent & { level?: string; message?: string })
      | undefined;
    expect(logged).toBeDefined();
    expect(logged?.message).toBe("hello from codex");
    expect(logged?.level).toBe("info");
    expect(logged?.runId).toBe("run_1");
    expect(typeof logged?.timestamp).toBe("number");
    // The final drain (drain-until-empty) runs before finalize.
    expect(finalDrained).toBe(true);
  });

  it("redacts the vended access token from every emitted channel (H1)", async () => {
    const TOKEN = "tok-real-SECRET-abcdef1234567890";
    const ACCOUNT = "acct-SECRET-0987654321";
    // The agent echoes the real token in its assistant text AND a shell command,
    // and a turn.failed names it in the error — all of which leave the runner via
    // the event sink. None must carry the token verbatim.
    const child: CodexChild = {
      stdout: ndjsonStream([
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: `here is my token: ${TOKEN} and ${ACCOUNT}` },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", command: `curl -H "auth: ${TOKEN}" host` },
        }),
        JSON.stringify({ type: "turn.failed", error: { message: `boom with ${TOKEN}` } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
      ]),
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
      fetchFn: vendFetch({ access_token: TOKEN, account_id: ACCOUNT }),
      spawn: () => child,
      now: () => 1_700_000_000_000,
    });
    await runner.run({ bundle, context: ctx, eventSink: h.sink });

    // No emitted event — on ANY channel — may carry the token or account id.
    const serialized = JSON.stringify(h.events);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(ACCOUNT);

    // The assistant message still surfaced, with the secret swapped for the marker.
    const progress = h.events.find(
      (e) =>
        e.type === "appstrate.progress" &&
        typeof (e as RunEvent & { message?: string }).message === "string" &&
        (e as RunEvent & { message: string }).message.startsWith("here is my token"),
    ) as (RunEvent & { message: string }) | undefined;
    expect(progress).toBeDefined();
    expect(progress?.message).toContain("[REDACTED]");

    // The error message reached the sink redacted too.
    const errored = h.events.find((e) => e.type === "appstrate.error") as
      | (RunEvent & { message?: string })
      | undefined;
    expect(errored?.message).toContain("[REDACTED]");
    expect(errored?.message).not.toContain(TOKEN);
  });

  it("scrubs the vended token from the terminal RunResult error (F1), not just events", async () => {
    const TOKEN = "tok-real-SECRET-abcdef1234567890";
    const ACCOUNT = "acct-SECRET-0987654321";
    // A turn.failed whose message names the vended token/account id. The event
    // stream is scrubbed by emit(); this asserts the FINAL RESULT is too.
    const child: CodexChild = {
      stdout: ndjsonStream([
        JSON.stringify({
          type: "turn.failed",
          error: { message: `auth blew up with token ${TOKEN} for ${ACCOUNT}` },
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
      systemPrompt: "",
      credentialUrl: "http://sidecar:8080/credential-vend",
      cwd: "/workspace",
      fetchFn: vendFetch({ access_token: TOKEN, account_id: ACCOUNT }),
      spawn: () => child,
      now: () => 1_700_000_000_000,
    });
    await runner.run({ bundle, context: ctx, eventSink: h.sink });

    expect(h.result?.status).toBe("failed");
    // Assert on the RESULT object — the whole thing, not just the events.
    const serializedResult = JSON.stringify(h.result);
    expect(serializedResult).not.toContain(TOKEN);
    expect(serializedResult).not.toContain(ACCOUNT);
    // The error message still surfaced, with the secret swapped for the marker.
    expect(h.result?.error?.message).toContain("[REDACTED]");
  });

  it("scrubs the vended token from the RunResult error on the catch path (F1)", async () => {
    const TOKEN = "tok-throw-SECRET-abcdef1234567890";
    // The NDJSON stream throws mid-read with a message embedding the token.
    const throwingStream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error(`stream blew up exposing ${TOKEN}`);
      },
    });
    const child: CodexChild = {
      stdout: throwingStream,
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
      fetchFn: vendFetch({ access_token: TOKEN }),
      spawn: () => child,
      now: () => 1_700_000_000_000,
    });
    await runner.run({ bundle, context: ctx, eventSink: h.sink });

    expect(h.result?.status).toBe("failed");
    expect(JSON.stringify(h.result)).not.toContain(TOKEN);
    expect(h.result?.error?.message).toContain("[REDACTED]");
  });

  it("runs without a drainer (no runtime tools) and never reads result _meta", async () => {
    const child: CodexChild = {
      stdout: ndjsonStream([
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "mcp_tool_call",
            tool: "log",
            status: "completed",
            result: { content: [], _meta: { "dev.appstrate/events": [{ type: "log.written" }] } },
          },
        }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
      ]),
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
      sidecarMcp: { url: "http://sidecar:8080/mcp" },
      fetchFn: vendFetch({ access_token: "tok" }),
      spawn: () => child,
    });
    await runner.run({ bundle, context: ctx, eventSink: h.sink });
    // No drainer wired and `_meta` is never inspected → no runtime event surfaces.
    expect(h.events.some((e) => e.type === "log.written")).toBe(false);
    expect(h.result?.status).toBe("success");
  });
});
