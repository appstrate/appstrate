// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Guards the ORDERING INVARIANT in codex-agent-runner.ts: the redaction set
 * (`knownSecrets`) is armed synchronously right after the credential vend and
 * BEFORE the vended token is ever written to disk, spawned, or emitted. If
 * someone reorders the runner so the token is used/emitted before `knownSecrets`
 * is populated, these tests fail.
 *
 * The mechanism we exercise: the runner's `emit` closure scrubs by reading
 * `knownSecrets` at emit time. The spawn (and thus the first stream event the
 * agent produces) happens AFTER the arming push. We make the VERY FIRST stream
 * event carry the vended token verbatim — if arming were moved below spawn, that
 * first event would be emitted before the secret was registered and would leak.
 */

import { describe, it, expect } from "bun:test";
import { CodexAgentRunner, type CodexChild } from "../src/codex-agent-runner.ts";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import type { RunResult } from "@appstrate/afps-runtime/runner";

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

const ctx = { runId: "run_1", input: "go", memories: [], config: {} };
const bundle = {} as never;

function vendFetch(body: { access_token: string; account_id?: string | null }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("codex scrub is armed before first use (ordering invariant)", () => {
  const TOKEN = "tok-real-SECRET-abcdef1234567890";
  const ACCOUNT = "acct-SECRET-0987654321";

  it("redacts the vended token in the FIRST emitted stream event (armed before spawn)", async () => {
    // The very first NDJSON line — the agent's first message — names the token.
    // For it to be scrubbed, `knownSecrets` must already be armed by the time
    // spawn produced this stream, i.e. arming precedes spawn/first-use.
    const child: CodexChild = {
      stdout: ndjsonStream([
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: `first thing I print: ${TOKEN} / ${ACCOUNT}` },
        }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
      ]),
      stderr: emptyStream(),
      exited: Promise.resolve(0),
      kill() {},
    };

    let spawned = false;
    const h = makeSink();
    const runner = new CodexAgentRunner({
      binaryPath: "/fake/codex",
      modelId: "gpt-5.5",
      systemPrompt: "",
      credentialUrl: "http://sidecar:8080/credential-vend",
      cwd: "/workspace",
      fetchFn: vendFetch({ access_token: TOKEN, account_id: ACCOUNT }),
      spawn: () => {
        spawned = true;
        return child;
      },
      now: () => 1_700_000_000_000,
    });

    await runner.run({ bundle, context: ctx, eventSink: h.sink });

    // Spawn happened (so the stream really flowed through the post-arm path).
    expect(spawned).toBe(true);

    // The FIRST emitted event carrying the token is redacted — arming preceded
    // first use. No emitted event on any channel carries the token/account id.
    const first = h.events.find(
      (e) =>
        typeof (e as RunEvent & { message?: string }).message === "string" &&
        (e as RunEvent & { message: string }).message.startsWith("first thing I print"),
    ) as (RunEvent & { message: string }) | undefined;
    expect(first).toBeDefined();
    expect(first?.message).toContain("[REDACTED]");
    expect(first?.message).not.toContain(TOKEN);
    expect(first?.message).not.toContain(ACCOUNT);

    const serialized = JSON.stringify(h.events);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(ACCOUNT);
  });

  it("redacts the vended token in the terminal RunResult (armed before the result is assembled)", async () => {
    // A turn.failed naming the token folds into the terminal RunResult.error.
    // It is only scrubbed if `knownSecrets` was armed before the result was built.
    const child: CodexChild = {
      stdout: ndjsonStream([
        JSON.stringify({ type: "turn.failed", error: { message: `died holding ${TOKEN}` } }),
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
    expect(JSON.stringify(h.result)).not.toContain(TOKEN);
    expect(JSON.stringify(h.result)).not.toContain(ACCOUNT);
    expect(h.result?.error?.message).toContain("[REDACTED]");
  });
});
