// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { renderPrompt, buildPromptView } from "../../src/bundle/prompt-renderer.ts";
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
  it("surfaces ExecutionContext fields onto the view verbatim", async () => {
    const view = await buildPromptView({
      context: ctx({
        memories: MEMORIES,
        state: { counter: 7 },
        history: [{ runId: "prev", timestamp: 100, output: "x" }],
      }),
    });

    expect(view.runId).toBe("run_test");
    expect(view.input).toEqual({ topic: "test" });
    expect(view.memories).toEqual(MEMORIES);
    expect(view.state).toEqual({ counter: 7 });
    expect(view.history).toHaveLength(1);
  });

  it("defaults memories/history to empty and state to null when absent", async () => {
    const view = await buildPromptView({ context: ctx() });

    expect(view.memories).toEqual([]);
    expect(view.history).toEqual([]);
    expect(view.state).toBeNull();
  });

  it("treats state: null in context as explicit null", async () => {
    const view = await buildPromptView({ context: ctx({ state: null }) });
    expect(view.state).toBeNull();
  });

  it("respects memoryLimit", async () => {
    const view = await buildPromptView({
      context: ctx({ memories: MEMORIES }),
      memoryLimit: 1,
    });
    expect(view.memories).toHaveLength(1);
  });

  it("respects historyLimit", async () => {
    const view = await buildPromptView({
      context: ctx({
        history: [
          { runId: "r1", timestamp: 1, output: 1 },
          { runId: "r2", timestamp: 2, output: 2 },
          { runId: "r3", timestamp: 3, output: 3 },
        ],
      }),
      historyLimit: 2,
    });
    expect(view.history).toHaveLength(2);
  });

  it("surfaces ExecutionContext.config on the view when present", async () => {
    const view = await buildPromptView({
      context: ctx({ config: { threshold: 42, label: "prod" } }),
    });
    expect(view.config).toEqual({ threshold: 42, label: "prod" });
  });

  it("omits config from the view when absent on the context", async () => {
    const view = await buildPromptView({ context: ctx() });
    expect(view.config).toBeUndefined();
  });
});

describe("renderPrompt", () => {
  it("substitutes runId and input fields", async () => {
    const template = "Run: {{runId}} | Topic: {{input.topic}}";
    const out = await renderPrompt({
      template,
      context: ctx({ input: { topic: "physics" } }),
    });
    expect(out).toBe("Run: run_test | Topic: physics");
  });

  it("iterates memories via a section", async () => {
    const template = "Memories:\n{{#memories}}- {{content}}\n{{/memories}}";
    const out = await renderPrompt({
      template,
      context: ctx({ memories: MEMORIES }),
    });
    expect(out).toBe("Memories:\n- alpha\n- beta\n");
  });

  it("uses inverted section when memories are empty", async () => {
    const template = "{{^memories}}No prior memories.{{/memories}}";
    const out = await renderPrompt({
      template,
      context: ctx(),
    });
    expect(out).toBe("No prior memories.");
  });

  it("is deterministic: same template + context ⇒ same output", async () => {
    const template = "{{runId}}/{{#memories}}{{content}},{{/memories}}";
    const context = ctx({ memories: MEMORIES });
    const a = await renderPrompt({ template, context });
    const b = await renderPrompt({ template, context });
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
    });
    expect(out).toBe("run_test");
  });
});
