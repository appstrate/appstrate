// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Tests for the reusable credential-injecting HTTP-call core
 * (`http-call-core.ts`): `makeApiCallTool` (the Tool factory every
 * integration `api_call` resolver builds on). The credential-source-specific
 * local/remote integration resolvers are covered in `integration-api-call.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import {
  makeApiCallTool,
  type ApiCallMeta,
  type RunEvent,
  type ToolContext,
} from "../../src/resolvers/index.ts";

function makeCtx(): { ctx: ToolContext; events: RunEvent[] } {
  const events: RunEvent[] = [];
  return {
    events,
    ctx: {
      emit: (e) => {
        events.push(e);
      },
      workspace: "/tmp",
      runId: "run_test",
      toolCallId: "call_1",
      signal: new AbortController().signal,
    },
  };
}

describe("makeApiCallTool", () => {
  it("produces a {name}_call tool with JSON-schema parameters", () => {
    const meta: ApiCallMeta = { name: "@afps/gmail" };
    const tool = makeApiCallTool(meta, async () => ({
      status: 200,
      headers: {},
      body: { kind: "text", text: "" },
    }));
    expect(tool.name).toBe("afps_gmail_call");
    expect(tool.description).toContain("@afps/gmail");
    const params = tool.parameters as { required: string[] };
    expect(params.required).toContain("method");
    expect(params.required).toContain("target");
  });

  it("honours a toolName override (the {ns}__api_call shape integrations use)", () => {
    const meta: ApiCallMeta = { name: "@afps/gmail" };
    const tool = makeApiCallTool(
      meta,
      async () => ({ status: 200, headers: {}, body: { kind: "text", text: "" } }),
      { toolName: "afps_gmail__api_call" },
    );
    expect(tool.name).toBe("afps_gmail__api_call");
  });

  it("emits api_call.called with status + duration on success", async () => {
    const meta: ApiCallMeta = { name: "@acme/ok" };
    const tool = makeApiCallTool(meta, async () => ({
      status: 201,
      headers: {},
      body: { kind: "text", text: "created" },
    }));
    const { ctx, events } = makeCtx();
    await tool.execute({ method: "POST", target: "https://api.acme.com/x" }, ctx);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("api_call.called");
    expect(events[0]!.status).toBe(201);
    expect(events[0]!.integrationId).toBe("@acme/ok");
  });

  it("marks tool results as isError on 4xx/5xx", async () => {
    const meta: ApiCallMeta = { name: "@acme/err" };
    const tool = makeApiCallTool(meta, async () => ({
      status: 404,
      headers: {},
      body: { kind: "text", text: "nope" },
    }));
    const { ctx } = makeCtx();
    const result = await tool.execute({ method: "GET", target: "https://api.acme.com/x" }, ctx);
    expect(result.isError).toBe(true);
  });
});
