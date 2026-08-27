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

  it("host `**` does not cross the authority boundary into the path", () => {
    const pat = "https://**.example.com/**";
    // Legitimate host matches.
    expect(matchesAuthorizedUriSpec(pat, "https://api.example.com/x")).toBe(true);
    expect(matchesAuthorizedUriSpec(pat, "https://a.b.example.com/x/y")).toBe(true);
    // Authority-boundary bypass: the real host is evil.com; the pattern
    // must NOT let a path segment masquerade as the host.
    expect(matchesAuthorizedUriSpec(pat, "https://evil.com/x/.example.com/y")).toBe(false);
    expect(matchesAuthorizedUriSpec(pat, "https://evil.com/.example.com/y")).toBe(false);
  });

  it("host `**` alone matches any host but never the path portion", () => {
    const pat = "https://**/health";
    expect(matchesAuthorizedUriSpec(pat, "https://api.acme.com/health")).toBe(true);
    // `**` in the host cannot swallow the `/` that ends the authority.
    expect(matchesAuthorizedUriSpec(pat, "https://api.acme.com/v1/health")).toBe(false);
  });

  // The authority fragment is `[^/]*`, so the ONLY separator it cannot cross
  // is `/`. `?`, `#` and `@` also end an authority and are not `/` — matching
  // the RAW target string therefore let an attacker host wear an allowlisted
  // suffix. Each case below pairs the bypass with BOTH controls (a real host
  // that must still match, an attacker host that must still be refused) so a
  // change that breaks matching outright cannot masquerade as a fix.
  // `https://*.salesforce.com/**` is a shipped system-integration pattern.
  const SALESFORCE = "https://*.salesforce.com/**";

  it("`?` cannot smuggle an allowlisted suffix past the authority boundary", () => {
    // Real host is `attacker.example`; everything after `?` is the query.
    expect(
      matchesAuthorizedUriSpec(SALESFORCE, "https://attacker.example?.salesforce.com/steal"),
    ).toBe(false);
    expect(
      matchesAuthorizedUriSpec("https://*.zendesk.com/**", "https://evil.test?.zendesk.com/x"),
    ).toBe(false);
    // Positive control — a genuine subdomain still matches.
    expect(matchesAuthorizedUriSpec(SALESFORCE, "https://foo.salesforce.com/ok")).toBe(true);
    // Negative control — a bare attacker host was always refused.
    expect(matchesAuthorizedUriSpec(SALESFORCE, "https://attacker.example/steal")).toBe(false);
  });

  it("`#` cannot smuggle an allowlisted suffix past the authority boundary", () => {
    // Real host is `attacker.example`; everything after `#` is the fragment
    // and is never even sent on the wire.
    expect(
      matchesAuthorizedUriSpec(SALESFORCE, "https://attacker.example#.salesforce.com/steal"),
    ).toBe(false);
    expect(matchesAuthorizedUriSpec(SALESFORCE, "https://foo.salesforce.com/ok")).toBe(true);
    expect(matchesAuthorizedUriSpec(SALESFORCE, "https://attacker.example/steal")).toBe(false);
  });

  it("userinfo `@` cannot make an attacker host wear an allowlisted name", () => {
    // Checked as part of the `?`/`#` fix: `@` also detaches an authority, but
    // it was NOT a bypass against a suffix-anchored host pattern — the
    // authority `foo.salesforce.com@attacker.example` does not END in
    // `.salesforce.com`. Pinned so normalisation can never make it one.
    // Real host is `attacker.example`; `foo.salesforce.com` is userinfo.
    expect(
      matchesAuthorizedUriSpec(SALESFORCE, "https://foo.salesforce.com@attacker.example/x"),
    ).toBe(false);
    expect(
      matchesAuthorizedUriSpec(SALESFORCE, "https://foo.salesforce.com:tok@attacker.example/x"),
    ).toBe(false);
    // A fragment already stripped means the fragment can't re-add the host.
    expect(matchesAuthorizedUriSpec(SALESFORCE, "https://foo.salesforce.com/ok")).toBe(true);
    expect(matchesAuthorizedUriSpec(SALESFORCE, "https://attacker.example/steal")).toBe(false);
  });

  it("refuses a target that is not a parseable URL", () => {
    // Fail closed: a target whose real host we cannot name never gets the
    // integration credential. A raw-string matcher happily admitted these —
    // `[^/]*` does not care that a space is illegal in an authority — but
    // `new URL()` rejects them, so there is no host to authorise.
    expect(matchesAuthorizedUriSpec(SALESFORCE, "https://a b.salesforce.com/x")).toBe(false);
    expect(matchesAuthorizedUriSpec("https://**", "https://not a host/x")).toBe(false);
    expect(matchesAuthorizedUriSpec(SALESFORCE, "not a url")).toBe(false);
    expect(matchesAuthorizedUriSpec(SALESFORCE, "//foo.salesforce.com/ok")).toBe(false);
    // Positive controls — real URLs still match both patterns.
    expect(matchesAuthorizedUriSpec(SALESFORCE, "https://foo.salesforce.com/ok")).toBe(true);
    expect(matchesAuthorizedUriSpec("https://**", "https://foo.salesforce.com/ok")).toBe(true);
    // Negative control — a parseable attacker host is still refused.
    expect(matchesAuthorizedUriSpec(SALESFORCE, "https://attacker.example/steal")).toBe(false);
  });

  it("normalisation leaves path/query wildcards working", () => {
    const pat = "https://*.salesforce.com/services/data/**";
    expect(
      matchesAuthorizedUriSpec(
        pat,
        "https://foo.salesforce.com/services/data/v59.0/query?q=SELECT+Id",
      ),
    ).toBe(true);
    // Single-segment `*` still stops at a slash after normalisation.
    expect(matchesAuthorizedUriSpec("https://api.acme.com/*", "https://api.acme.com/users")).toBe(
      true,
    );
    expect(
      matchesAuthorizedUriSpec("https://api.acme.com/*", "https://api.acme.com/users/42"),
    ).toBe(false);
    // …and the path is still not a place to hide a host.
    expect(matchesAuthorizedUriSpec(pat, "https://attacker.example/services/data/v59.0")).toBe(
      false,
    );
  });
});
