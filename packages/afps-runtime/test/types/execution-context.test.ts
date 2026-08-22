// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { executionContextSchema } from "../../src/types/execution-context.ts";

describe("executionContextSchema", () => {
  it("accepts the minimal required shape", () => {
    const result = executionContextSchema.safeParse({
      runId: "run_abc123",
      input: { foo: "bar" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a fully-populated context", () => {
    const result = executionContextSchema.safeParse({
      runId: "run_abc123",
      input: { topic: "climate" },
      memories: [{ content: "user speaks French", createdAt: 1714000000000 }],
      checkpoint: { cursor: "xyz" },
      pinnedSlots: { plan: { step: 2 } },
      history: [
        {
          runId: "run_previous",
          timestamp: 1713000000000,
          output: { items: [] },
        },
      ],
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      timeoutSeconds: 1.5,
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-finite timeoutSeconds", () => {
    const result = executionContextSchema.safeParse({
      runId: "run_abc123",
      input: {},
      timeoutSeconds: Infinity,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing runId", () => {
    const result = executionContextSchema.safeParse({
      input: { foo: "bar" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty runId", () => {
    const result = executionContextSchema.safeParse({
      runId: "",
      input: {},
    });
    expect(result.success).toBe(false);
  });

  it("strips infrastructure wiring and auth material (§3 / §7)", () => {
    // The context carries run STATE only — never sink URLs, credential
    // endpoints, or secrets. The schema declares no such fields, and Zod's
    // default object behaviour strips unknown keys rather than failing. This
    // files the constraint in code form: even if a caller stuffs a secret
    // into a `context.json`, it does not round-trip through the parsed object.
    const parsed = executionContextSchema.parse({
      runId: "run_x",
      input: {},
      sink: {
        type: "http",
        url: "https://example.com/events",
        auth: { runSecret: "SHOULD_NOT_PERSIST" },
      },
      credentials: { type: "appstrate", endpoint: "https://example.com/credentials" },
      model: { provider: "anthropic", modelId: "claude-opus-4-7" },
    });
    const raw = parsed as Record<string, unknown>;
    expect(raw.sink).toBeUndefined();
    expect(raw.credentials).toBeUndefined();
    expect(raw.model).toBeUndefined();
  });

  it("accepts memories with createdAt timestamps", () => {
    const result = executionContextSchema.safeParse({
      runId: "run_x",
      input: {},
      memories: [
        { content: "a", createdAt: 1 },
        { content: "b", createdAt: 2 },
      ],
    });
    expect(result.success).toBe(true);
  });
});
