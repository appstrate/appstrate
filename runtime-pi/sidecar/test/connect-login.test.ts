// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the connect-login execution substrate (P1).
 *
 * Covers the pure transient-input substitution helper and the
 * `runConnectLogin` primitive end-to-end against a fake McpHost + a real
 * credentials source.
 */

import { describe, it, expect } from "bun:test";
import { applyConnectInputSubstitution } from "../integration-mitm-listener.ts";
import { runConnectLogin } from "../connect-login.ts";
import {
  createIntegrationCredentialsSource,
  type IntegrationCredentialsWire,
} from "../integration-credentials-source.ts";

// ─────────────────────────────────────────────
// applyConnectInputSubstitution (pure)
// ─────────────────────────────────────────────

describe("applyConnectInputSubstitution", () => {
  it("substitutes placeholders in url, body, and headers", () => {
    const result = applyConnectInputSubstitution(
      {
        url: "https://api.example.com/login?u={{username}}",
        bodyText: '{"password":"{{password}}"}',
        headers: { "X-Token": "{{token}}", "X-Static": "literal" },
      },
      { username: "alice", password: "s3cret", token: "tok-123" },
    );
    expect("failed" in result).toBe(false);
    if ("failed" in result) throw new Error("unexpected failure");
    expect(result.url).toBe("https://api.example.com/login?u=alice");
    expect(result.bodyText).toBe('{"password":"s3cret"}');
    expect(result.headers["X-Token"]).toBe("tok-123");
    expect(result.headers["X-Static"]).toBe("literal");
  });

  it("fails closed on an unknown placeholder", () => {
    const result = applyConnectInputSubstitution(
      { url: "https://api.example.com/x", bodyText: "secret={{missing}}", headers: {} },
      { username: "alice" },
    );
    expect("failed" in result).toBe(true);
    if ("failed" in result) expect(result.failed).toBe("missing");
  });

  it("fails closed when a header keeps an unresolved placeholder", () => {
    const result = applyConnectInputSubstitution(
      { url: "https://api.example.com/x", bodyText: null, headers: { Auth: "{{nope}}" } },
      { username: "alice" },
    );
    expect("failed" in result).toBe(true);
    if ("failed" in result) expect(result.failed).toBe("nope");
  });

  it("is a no-op when there are no placeholders", () => {
    const parts = {
      url: "https://api.example.com/plain",
      bodyText: "no placeholders here",
      headers: { Accept: "application/json" },
    };
    const result = applyConnectInputSubstitution(parts, { username: "alice" });
    expect("failed" in result).toBe(false);
    if ("failed" in result) throw new Error("unexpected failure");
    expect(result.url).toBe(parts.url);
    expect(result.bodyText).toBe(parts.bodyText);
    expect(result.headers).toEqual(parts.headers);
  });
});

// ─────────────────────────────────────────────
// runConnectLogin
// ─────────────────────────────────────────────

const DELIVERY_HTTP = {
  headerName: "Authorization",
  headerPrefix: "Bearer ",
  valueFrom: "access_token",
} as const;

function emptyWire(): IntegrationCredentialsWire {
  return { auths: [], deliveryPlans: {}, expiresAtEpochMs: {} };
}

function makeSource() {
  const fetchFn = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
  return createIntegrationCredentialsSource({
    integrationId: "@test/integ",
    platformApiUrl: "http://api",
    runToken: "run-tok",
    initialPayload: emptyWire(),
    fetchFn,
  });
}

interface CallToolCapture {
  args: { name: string; arguments?: Record<string, unknown> };
}

/**
 * Fake McpHost exposing only `getUpstreamClient`. The fake client records
 * the `callTool` args (so tests can assert the secret never travels as a
 * tool argument) and returns a canned JSON content block. It also records
 * the credentials source's `activeInputs()` at call time so we can prove
 * the substitution window was open during the tool call.
 */
function makeFakeHost(
  namespace: string,
  cannedResult: { content: Array<{ type: string; text: string }> },
  observeActiveInputs?: () => Record<string, string> | null,
): {
  host: { getUpstreamClient(ns: string): unknown };
  capture: CallToolCapture;
  activeDuringCall: { value: Record<string, string> | null };
} {
  const capture: CallToolCapture = { args: { name: "", arguments: undefined } };
  const activeDuringCall = { value: null as Record<string, string> | null };
  const client = {
    callTool(args: { name: string; arguments?: Record<string, unknown> }) {
      capture.args = args;
      if (observeActiveInputs) activeDuringCall.value = observeActiveInputs();
      return Promise.resolve(cannedResult);
    },
  };
  return {
    host: {
      getUpstreamClient(ns: string) {
        return ns === namespace ? client : undefined;
      },
    },
    capture,
    activeDuringCall,
  };
}

describe("runConnectLogin", () => {
  it("captures the session, opens then clears the substitution window, and renders the header", async () => {
    const source = makeSource();
    const canned = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ outputs: { access_token: "TOK" }, expiresAt: null }),
        },
      ],
    };
    const { host, capture, activeDuringCall } = makeFakeHost("ns", canned, () =>
      source.activeInputs(),
    );

    const bundle = await runConnectLogin({
       
      host: host as any,
      namespace: "ns",
      toolName: "login",
      inputs: { password: "s3cret" },
      source,
      authKey: "primary",
      authType: "oauth2",
      authorizedUris: ["https://api.example.com/**"],
      deliveryHttp: DELIVERY_HTTP,
    });

    // Window was open during the call …
    expect(activeDuringCall.value).toEqual({ password: "s3cret" });
    // … and is closed afterwards.
    expect(source.activeInputs()).toBeNull();

    // The session header now renders from the captured outputs.
    const plans = source.deliveryPlans();
    expect(plans.primary?.headerName).toBe("Authorization");
    expect(plans.primary?.headerPrefix).toBe("Bearer ");
    expect(plans.primary?.value).toBe("TOK");

    // Bundle carries outputs; never the inputs.
    expect(bundle.outputs).toEqual({ access_token: "TOK" });
    expect((bundle as unknown as Record<string, unknown>).inputs).toBeUndefined();

    // The secret never travelled as a tool argument.
    expect(capture.args.name).toBe("login");
    expect(capture.args.arguments).toEqual({});
  });

  it("clears the substitution window even when the tool call rejects", async () => {
    const source = makeSource();
    const client = {
      callTool() {
        return Promise.reject(new Error("boom"));
      },
    };
    const host = {
      getUpstreamClient(ns: string) {
        return ns === "ns" ? client : undefined;
      },
    };
    await expect(
      runConnectLogin({
         
        host: host as any,
        namespace: "ns",
        toolName: "login",
        inputs: { password: "s3cret" },
        source,
        authKey: "primary",
        authType: "oauth2",
        authorizedUris: [],
        deliveryHttp: DELIVERY_HTTP,
      }),
    ).rejects.toThrow("boom");
    expect(source.activeInputs()).toBeNull();
  });

  it("rejects an output not in the produces allowlist", async () => {
    const source = makeSource();
    const canned = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ outputs: { access_token: "TOK", sneaky: "X" } }),
        },
      ],
    };
    const { host } = makeFakeHost("ns", canned);

    await expect(
      runConnectLogin({
         
        host: host as any,
        namespace: "ns",
        toolName: "login",
        produces: ["access_token"],
        inputs: { password: "s3cret" },
        source,
        authKey: "primary",
        authType: "oauth2",
        authorizedUris: [],
        deliveryHttp: DELIVERY_HTTP,
      }),
    ).rejects.toThrow("undeclared output 'sneaky'");
    // Window still closed after the rejection.
    expect(source.activeInputs()).toBeNull();
  });

  it("throws when the upstream client is missing", async () => {
    const source = makeSource();
    const host = { getUpstreamClient: () => undefined };
    await expect(
      runConnectLogin({
         
        host: host as any,
        namespace: "absent",
        toolName: "login",
        inputs: {},
        source,
        authKey: "primary",
        authType: "oauth2",
        authorizedUris: [],
        deliveryHttp: DELIVERY_HTTP,
      }),
    ).rejects.toThrow("no upstream client");
  });
});

// ─────────────────────────────────────────────
// credentials source — activeInputs() lifecycle
// ─────────────────────────────────────────────

describe("IntegrationCredentialsSource active-input window", () => {
  it("defaults to null and toggles via set/clear", () => {
    const source = makeSource();
    expect(source.activeInputs()).toBeNull();
    source.setActiveInputs({ password: "p" });
    expect(source.activeInputs()).toEqual({ password: "p" });
    source.clearActiveInputs();
    expect(source.activeInputs()).toBeNull();
  });

  it("setSessionOutputs replaces auths and records expiry", () => {
    const source = makeSource();
    const expiresAt = "2030-01-01T00:00:00.000Z";
    source.setSessionOutputs(
      {
        authKey: "primary",
        authType: "oauth2",
        fields: { access_token: "TOK" },
        authorizedUris: ["https://api.example.com/**"],
        expiresAt,
      },
      {
        headerName: "Authorization",
        headerPrefix: "Bearer ",
        value: "TOK",
        allowServerOverride: false,
      },
    );
    const snap = source.snapshot();
    expect(snap.auths.length).toBe(1);
    expect(snap.auths[0]?.authKey).toBe("primary");
    expect(snap.deliveryPlans.primary?.value).toBe("TOK");
    expect(snap.expiresAtEpochMs.primary).toBe(Date.parse(expiresAt));
  });
});
