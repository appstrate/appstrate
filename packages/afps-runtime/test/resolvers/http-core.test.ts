// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Tests for the reusable credential-injecting HTTP-call core
 * (`http-call-core.ts`): `makeApiCallTool` (the Tool factory every
 * integration `api_call` resolver builds on) and `matchesAuthorizedUriSpec`
 * (the URL allowlist matcher). The credential-source-specific local/remote
 * integration resolvers are covered in `integration-api-call.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import {
  makeApiCallTool,
  matchesAuthorizedUriSpec,
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
    const meta: ApiCallMeta = { name: "@afps/gmail", allowAllUris: true };
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
    const meta: ApiCallMeta = { name: "@afps/gmail", allowAllUris: true };
    const tool = makeApiCallTool(
      meta,
      async () => ({ status: 200, headers: {}, body: { kind: "text", text: "" } }),
      { toolName: "afps_gmail__api_call" },
    );
    expect(tool.name).toBe("afps_gmail__api_call");
  });

  it("enforces authorizedUris when allowAllUris is not set", async () => {
    const meta: ApiCallMeta = {
      name: "@acme/scoped",
      authorizedUris: ["https://api.acme.com/**"],
    };
    const tool = makeApiCallTool(meta, async () => ({
      status: 200,
      headers: {},
      body: { kind: "text", text: "" },
    }));
    const { ctx } = makeCtx();
    await expect(
      tool.execute({ method: "GET", target: "https://evil.example.com/x" }, ctx),
    ).rejects.toThrow(/not in authorized_uris/);
  });

  it("emits api_call.called with status + duration on success", async () => {
    const meta: ApiCallMeta = { name: "@acme/ok", allowAllUris: true };
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
    const meta: ApiCallMeta = { name: "@acme/err", allowAllUris: true };
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

describe("matchesAuthorizedUriSpec", () => {
  it("** matches any path suffix including multi-segment and query", () => {
    const pat = "https://gmail.googleapis.com/**";
    expect(matchesAuthorizedUriSpec(pat, "https://gmail.googleapis.com/")).toBe(true);
    expect(matchesAuthorizedUriSpec(pat, "https://gmail.googleapis.com/v1")).toBe(true);
    expect(matchesAuthorizedUriSpec(pat, "https://gmail.googleapis.com/gmail/v1/users/me")).toBe(
      true,
    );
    expect(
      matchesAuthorizedUriSpec(
        pat,
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10",
      ),
    ).toBe(true);
  });

  it("* matches a single path segment only — does not cross slashes", () => {
    const pat = "https://api.acme.com/*";
    expect(matchesAuthorizedUriSpec(pat, "https://api.acme.com/users")).toBe(true);
    expect(matchesAuthorizedUriSpec(pat, "https://api.acme.com/users/42")).toBe(false);
    expect(matchesAuthorizedUriSpec(pat, "https://api.acme.com/")).toBe(true);
  });

  it("anchors the pattern — prefix-only matches are rejected", () => {
    expect(
      matchesAuthorizedUriSpec(
        "https://api.acme.com/**",
        "https://evil.com/?x=https://api.acme.com/anything",
      ),
    ).toBe(false);
  });

  it("escapes regex metacharacters in the pattern so they cannot inject", () => {
    expect(matchesAuthorizedUriSpec("https://api.acme.com/x.y", "https://apiXacmeXcom/xXy")).toBe(
      false,
    );
    expect(matchesAuthorizedUriSpec("https://api.acme.com/x.y", "https://api.acme.com/x.y")).toBe(
      true,
    );
  });

  it("subdomain wildcards stay single-segment and reject host smuggling", () => {
    const pat = "https://*.acme.com/**";
    expect(matchesAuthorizedUriSpec(pat, "https://eu.acme.com/v1/users/42")).toBe(true);
    expect(matchesAuthorizedUriSpec(pat, "https://evil.com/x.acme.com/y")).toBe(false);
  });
});
