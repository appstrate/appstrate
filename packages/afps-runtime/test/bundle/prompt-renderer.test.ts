// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { renderPrompt, buildPromptView } from "../../src/bundle/prompt-renderer.ts";
import { NoopContextProvider } from "../../src/providers/context/noop-provider.ts";
import { SnapshotContextProvider } from "../../src/providers/context/snapshot-provider.ts";
import type { ContextProvider } from "../../src/interfaces/context-provider.ts";
import type { ExecutionContext, MemorySnapshot } from "../../src/types/execution-context.ts";

const MEMORIES: MemorySnapshot[] = [
  { content: "alpha", createdAt: 1000 },
  { content: "beta", createdAt: 2000 },
];

function ctx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    runId: "run_test",
    input: { topic: "test" },
    ...overrides,
  };
}

describe("buildPromptView", () => {
  it("uses ExecutionContext values when present (no provider call)", async () => {
    let providerCalled = false;
    const provider: ContextProvider = {
      async getMemories() {
        providerCalled = true;
        return [];
      },
      async getHistory() {
        providerCalled = true;
        return [];
      },
      async getState() {
        providerCalled = true;
        return null;
      },
    };

    const view = await buildPromptView({
      context: ctx({
        memories: MEMORIES,
        state: { counter: 7 },
        history: [{ runId: "prev", timestamp: 100, output: "x" }],
      }),
      provider,
    });

    expect(view.runId).toBe("run_test");
    expect(view.input).toEqual({ topic: "test" });
    expect(view.memories).toEqual(MEMORIES);
    expect(view.state).toEqual({ counter: 7 });
    expect(view.history).toHaveLength(1);
    expect(providerCalled).toBe(false);
  });

  it("falls back to the provider when context is bare", async () => {
    const provider = new SnapshotContextProvider({
      memories: MEMORIES,
      state: "fallback",
      history: [{ runId: "prev", timestamp: 100, output: "y" }],
    });
    const view = await buildPromptView({ context: ctx(), provider });

    expect(view.memories).toEqual(MEMORIES);
    expect(view.state).toBe("fallback");
    expect(view.history).toHaveLength(1);
  });

  it("treats state: null in context as explicit null (does not fall back)", async () => {
    const provider = new SnapshotContextProvider({ state: "should-not-see-this" });
    const view = await buildPromptView({
      context: ctx({ state: null }),
      provider,
    });
    expect(view.state).toBeNull();
  });

  it("respects memoryLimit", async () => {
    const provider = new SnapshotContextProvider({ memories: MEMORIES });
    const view = await buildPromptView({
      context: ctx(),
      provider,
      memoryLimit: 1,
    });
    expect(view.memories).toHaveLength(1);
  });

  it("respects historyLimit", async () => {
    const provider = new SnapshotContextProvider({
      history: [
        { runId: "r1", timestamp: 1, output: 1 },
        { runId: "r2", timestamp: 2, output: 2 },
        { runId: "r3", timestamp: 3, output: 3 },
      ],
    });
    const view = await buildPromptView({
      context: ctx(),
      provider,
      historyLimit: 2,
    });
    expect(view.history).toHaveLength(2);
  });

  it("works with a stateless NoopContextProvider", async () => {
    const view = await buildPromptView({
      context: ctx(),
      provider: new NoopContextProvider(),
    });
    expect(view.memories).toEqual([]);
    expect(view.history).toEqual([]);
    expect(view.state).toBeNull();
  });
});

describe("renderPrompt", () => {
  it("substitutes runId and input fields", async () => {
    const template = "Run: {{runId}} | Topic: {{input.topic}}";
    const out = await renderPrompt({
      template,
      context: ctx({ input: { topic: "physics" } }),
      provider: new NoopContextProvider(),
    });
    expect(out).toBe("Run: run_test | Topic: physics");
  });

  it("iterates memories via a section", async () => {
    const template = "Memories:\n{{#memories}}- {{content}}\n{{/memories}}";
    const out = await renderPrompt({
      template,
      context: ctx(),
      provider: new SnapshotContextProvider({ memories: MEMORIES }),
    });
    expect(out).toBe("Memories:\n- alpha\n- beta\n");
  });

  it("uses inverted section when memories are empty", async () => {
    const template = "{{^memories}}No prior memories.{{/memories}}";
    const out = await renderPrompt({
      template,
      context: ctx(),
      provider: new NoopContextProvider(),
    });
    expect(out).toBe("No prior memories.");
  });

  it("is deterministic: same template + view ⇒ same output", async () => {
    const template = "{{runId}}/{{#memories}}{{content}},{{/memories}}";
    const context = ctx({ memories: MEMORIES });
    const provider = new NoopContextProvider();
    const a = await renderPrompt({ template, context, provider });
    const b = await renderPrompt({ template, context, provider });
    expect(a).toBe(b);
  });

  it("does not execute code from the view (logic-less guarantee)", async () => {
    const template = "{{runId}}";
    const out = await renderPrompt({
      template,
      context: ctx({
        runId: "run_test",
        input: { evil: "() => { throw 'boom' }" },
      }),
      provider: new NoopContextProvider(),
    });
    expect(out).toBe("run_test");
  });
});
