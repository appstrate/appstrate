// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * PiRunner tests using an injected session factory — no real Pi SDK
 * call, no LLM traffic, fully deterministic. The fake factory uses
 * {@link registerAfpsTools} against its own mini-registrar and replays
 * a scripted sequence of tool invocations when `.prompt()` is called.
 */

import { describe, it, expect } from "bun:test";
import { zipSync } from "fflate";
import { PiRunner, type PiSessionFactory } from "../../src/runner/pi.ts";
import { loadBundleFromBuffer } from "../../src/bundle/loader.ts";
import { SnapshotContextProvider } from "../../src/providers/context/snapshot-provider.ts";
import {
  registerAfpsTools,
  type PiExtensionRegistrar,
  type PiToolConfig,
} from "../../src/runner/pi-tools.ts";
import type { EventSink } from "../../src/interfaces/event-sink.ts";
import type { RunEvent } from "../../src/types/run-event.ts";
import type { RunResult } from "../../src/types/run-result.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const MANIFEST = {
  name: "@acme/hello",
  version: "1.0.0",
  type: "agent",
  schemaVersion: "1.1",
  displayName: "Hello",
  author: "Acme",
};

function loadRef(prompt = "hello {{runId}}") {
  return loadBundleFromBuffer(
    zipSync({
      "manifest.json": enc(JSON.stringify(MANIFEST)),
      "prompt.md": enc(prompt),
    }),
  );
}

function collecting(): EventSink & {
  events: RunEvent[];
  finalized: RunResult[];
} {
  const events: RunEvent[] = [];
  const finalized: RunResult[] = [];
  return {
    events,
    finalized,
    handle: async (event) => {
      events.push(event);
    },
    finalize: async (r) => {
      finalized.push(r);
    },
  };
}

const PARAMS = {
  addMemory: {},
  setState: {},
  output: {},
  report: {},
  log: {},
};

/**
 * Build a fake session factory that registers the AFPS tool extension
 * against its own in-memory registrar, then runs a caller-supplied
 * script on `prompt()` — each script entry names a tool and its args.
 */
function fakeFactory(script: ReadonlyArray<{ tool: string; args: unknown }>): PiSessionFactory {
  return async ({ emit }) => {
    const tools = new Map<string, PiToolConfig>();
    const registrar: PiExtensionRegistrar = {
      registerTool(cfg) {
        tools.set(cfg.name, cfg);
        return undefined;
      },
    };
    registerAfpsTools(registrar, { emit, parametersFactory: PARAMS });
    return {
      prompt: async () => {
        for (const step of script) {
          const tool = tools.get(step.tool);
          if (!tool) throw new Error(`fake script references unknown tool '${step.tool}'`);
          await tool.execute("fake-id", step.args);
        }
      },
    };
  };
}

describe("PiRunner — with injected session factory", () => {
  it("runs a scripted agent, emitting each tool call as the matching AfpsEvent", async () => {
    const sink = collecting();
    const runner = new PiRunner({
      model: { id: "model-x", api: "anthropic-messages" },
      apiKey: "test-key",
      sessionFactory: fakeFactory([
        { tool: "log", args: { level: "info", message: "starting" } },
        { tool: "add_memory", args: { content: "remember this" } },
        { tool: "set_state", args: { state: { step: 1 } } },
        { tool: "output", args: { data: { answer: 42 } } },
        { tool: "report", args: { content: "done" } },
      ]),
    });
    await runner.run({
      bundle: loadRef(),
      context: { runId: "run_pi", input: {} },
      sink,
      contextProvider: new SnapshotContextProvider(),
    });
    expect(sink.events).toHaveLength(5);
    expect(sink.events.every((e) => e.runId === "run_pi")).toBe(true);
    expect(sink.events.map((e) => e.type)).toEqual([
      "log.written",
      "memory.added",
      "state.set",
      "output.emitted",
      "report.appended",
    ]);
    expect(sink.finalized).toHaveLength(1);
    const r = sink.finalized[0]!;
    expect(r.memories.map((m) => m.content)).toEqual(["remember this"]);
    expect(r.state).toEqual({ step: 1 });
    expect(r.output).toEqual({ answer: 42 });
    expect(r.report).toBe("done");
  });

  it("reports a session-level error via log + RunResult.error", async () => {
    const sink = collecting();
    const factory: PiSessionFactory = async () => ({
      prompt: async () => {
        throw new Error("provider timeout");
      },
    });
    const runner = new PiRunner({
      model: { id: "x", api: "anthropic-messages" },
      apiKey: "k",
      sessionFactory: factory,
    });
    const result = await runner.run({
      bundle: loadRef(),
      context: { runId: "r", input: {} },
      sink,
      contextProvider: new SnapshotContextProvider(),
    });
    expect(result.error?.message).toBe("provider timeout");
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.type).toBe("log.written");
    expect(sink.events[0]!.level).toBe("error");
    expect(sink.events[0]!.message).toBe("provider timeout");
    expect(sink.finalized).toHaveLength(1);
  });

  it("renders the prompt before constructing the session and forwards it", async () => {
    let capturedPrompt = "";
    const factory: PiSessionFactory = async ({ systemPrompt }) => {
      capturedPrompt = systemPrompt;
      return { prompt: async () => undefined };
    };
    await new PiRunner({
      model: { id: "x", api: "anthropic-messages" },
      apiKey: "k",
      sessionFactory: factory,
    }).run({
      bundle: loadRef("topic={{input.topic}} run={{runId}}"),
      context: { runId: "run_X", input: { topic: "finance" } },
      sink: collecting(),
      contextProvider: new SnapshotContextProvider(),
    });
    expect(capturedPrompt).toContain("topic=finance");
    expect(capturedPrompt).toContain("run=run_X");
  });

  it("throws through the AbortSignal path before calling the factory", async () => {
    const controller = new AbortController();
    controller.abort();
    const sink = collecting();
    let factoryCalled = false;
    const factory: PiSessionFactory = async () => {
      factoryCalled = true;
      return { prompt: async () => undefined };
    };
    await expect(
      new PiRunner({
        model: { id: "x", api: "anthropic-messages" },
        apiKey: "k",
        sessionFactory: factory,
      }).run({
        bundle: loadRef(),
        context: { runId: "r", input: {} },
        sink,
        contextProvider: new SnapshotContextProvider(),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(factoryCalled).toBe(false);
    expect(sink.events).toHaveLength(0);
    expect(sink.finalized).toHaveLength(0);
  });

  it("exposes onPromptRendered for observability", async () => {
    let observed: string | undefined;
    const factory: PiSessionFactory = async () => ({ prompt: async () => undefined });
    await new PiRunner({
      model: { id: "x", api: "anthropic-messages" },
      apiKey: "k",
      sessionFactory: factory,
      onPromptRendered: (s) => {
        observed = s;
      },
    }).run({
      bundle: loadRef("prompt-xyz"),
      context: { runId: "r", input: {} },
      sink: collecting(),
      contextProvider: new SnapshotContextProvider(),
    });
    expect(observed).toContain("prompt-xyz");
  });
});
