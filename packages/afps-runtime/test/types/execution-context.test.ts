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
      history: [
        {
          runId: "run_previous",
          timestamp: 1713000000000,
          output: { items: [] },
        },
      ],
      sink: { type: "http", url: "https://appstrate.example/events" },
      credentials: {
        type: "appstrate",
        endpoint: "https://appstrate.example/credentials",
      },
      context: { type: "appstrate", endpoint: "https://appstrate.example/context" },
      model: {
        provider: "anthropic",
        modelId: "claude-opus-4-7",
        apiKeyRef: "env:ANTHROPIC_API_KEY",
      },
      dryRun: false,
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });
    expect(result.success).toBe(true);
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

  it("accepts sink config without any auth field (by design)", () => {
    const result = executionContextSchema.safeParse({
      runId: "run_x",
      input: {},
      sink: { type: "http", url: "https://example.com/events" },
    });
    expect(result.success).toBe(true);
  });

  it("strips unexpected auth property on http sink (Zod default strip)", () => {
    // The schema does not define an `auth` field — Zod's default object
    // behaviour is to strip unknown keys rather than fail. We document
    // this here so the constraint (§3 / §7: no HMAC in context.json) is
    // visible in code form: even if someone puts a secret in, it does
    // not round-trip through the parsed object.
    const raw = {
      runId: "run_x",
      input: {},
      sink: {
        type: "http",
        url: "https://example.com/events",
        auth: { runSecret: "SHOULD_NOT_PERSIST" },
      },
    };
    const parsed = executionContextSchema.parse(raw);
    expect((parsed.sink as Record<string, unknown> | undefined)?.auth).toBeUndefined();
  });

  it("rejects http sink with invalid URL", () => {
    const result = executionContextSchema.safeParse({
      runId: "run_x",
      input: {},
      sink: { type: "http", url: "not-a-url" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects file sink without path", () => {
    const result = executionContextSchema.safeParse({
      runId: "run_x",
      input: {},
      sink: { type: "file" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown sink type", () => {
    const result = executionContextSchema.safeParse({
      runId: "run_x",
      input: {},
      sink: { type: "slack", url: "https://slack.com" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown credentials type", () => {
    const result = executionContextSchema.safeParse({
      runId: "run_x",
      input: {},
      credentials: { type: "wizard" },
    });
    expect(result.success).toBe(false);
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
