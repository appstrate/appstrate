// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { forwardedLlmRequestHeaders } from "../src/llm-request-headers.ts";

const KEPT: Record<string, string> = {
  "Content-Type": "application/json",
  accept: "text/event-stream",
  "User-Agent": "Anthropic/JS 0.60.0",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
  "OpenAI-Beta": "responses=v1",
  "X-Opencode-Session": "ses_abc",
  "HTTP-Referer": "https://example.test",
  "x-title": "pi",
  "x-session-id": "sess_1",
  "x-stainless-os": "Linux",
  "x-vendor-foo": "bar",
  traceparent: "00-abc-def-01",
};

const DROPPED: Record<string, string> = {
  // transport
  Host: "sidecar:8080",
  "Content-Length": "42",
  "Accept-Encoding": "gzip, br",
  Connection: "keep-alive",
  "Transfer-Encoding": "chunked",
  "Proxy-Authorization": "Basic x",
  // inbound credentials
  Authorization: "Bearer appstrate-caller-token",
  "X-Api-Key": "sk-caller",
  "x-goog-api-key": "caller-google",
  "api-key": "caller-azure",
  Cookie: "session=abc",
  // platform-internal
  "X-Appstrate-Sidecar-Auth": "run-secret",
  "x-appstrate-pi-sdk": "0.86.1",
  "Appstrate-Version": "2026-01-01",
  "Appstrate-User": "eu_1",
  "X-Org-Id": "org_1",
  "X-Space-Id": "spc_1",
  "X-Run-Id": "run_1",
  // client network identity
  Forwarded: "for=10.0.0.1",
  "X-Forwarded-For": "10.0.0.1",
  "x-forwarded-host": "app.example",
  "X-Real-IP": "10.0.0.1",
  "True-Client-IP": "10.0.0.1",
  "CF-Connecting-IP": "10.0.0.1",
  "cf-ipcountry": "FR",
  "CF-Ray": "abc-CDG",
  Via: "1.1 edge",
};

describe("forwardedLlmRequestHeaders", () => {
  it("forwards every SDK header except transport, credential, platform and identity ones", () => {
    const out = forwardedLlmRequestHeaders({ ...KEPT, ...DROPPED });
    for (const [name, value] of Object.entries(KEPT)) expect(out.get(name)).toBe(value);
    for (const name of Object.keys(DROPPED)) expect(out.get(name)).toBeNull();
    expect([...out.keys()].sort()).toEqual(
      Object.keys(KEPT)
        .map((k) => k.toLowerCase())
        .sort(),
    );
  });

  it("accepts a Headers instance", () => {
    const out = forwardedLlmRequestHeaders(new Headers({ "x-vendor-foo": "bar", "x-run-id": "r" }));
    expect([...out]).toEqual([["x-vendor-foo", "bar"]]);
  });

  it("re-admits only the credential header carrying the placeholder, with the secret", () => {
    const credential = { placeholder: "sk-placeholder", secret: "sk-real" };
    const out = forwardedLlmRequestHeaders(
      {
        Authorization: "Bearer sk-placeholder",
        "x-api-key": "sk-someone-else",
        cookie: "sk-placeholder",
        "x-appstrate-sidecar-auth": "sk-placeholder",
        "x-vendor-foo": "bar",
      },
      credential,
    );
    expect(out.get("authorization")).toBe("Bearer sk-real");
    expect(out.get("x-api-key")).toBeNull();
    expect(out.get("x-appstrate-sidecar-auth")).toBeNull();
    expect(out.get("x-vendor-foo")).toBe("bar");
    // A cookie is never a provider credential slot.
    expect(out.get("cookie")).toBeNull();
  });

  // Each row: a header a caller, an auth proxy or a CDN may set, which must
  // never reach a vendor against a stored credential. Mixed case on purpose.
  const HARDENED_DROPS: [string, string][] = [
    // vendor account scoping
    ["OpenAI-Organization", "org-caller"],
    ["OpenAI-Project", "proj_caller"],
    // every Cloudflare edge header, not only the known ones
    ["CF-Connecting-IP", "10.0.0.1"],
    ["cf-ew-via", "15"],
    ["CF-Access-Jwt-Assertion", "eyJ"],
    ["cf-aig-authorization", "Bearer caller-gateway-key"],
    // auth-proxy identity
    ["X-Amzn-Oidc-Data", "eyJ"],
    ["x-amzn-oidc-identity", "user"],
    ["X-MS-CLIENT-PRINCIPAL", "eyJ"],
    ["x-ms-client-principal-name", "alice"],
    ["X-Ms-Token-Aad-Access-Token", "eyJ"],
    ["X-Goog-IAP-JWT-Assertion", "eyJ"],
    ["x-goog-authenticated-user-email", "accounts.google.com:alice"],
    ["X-Auth-Request-Email", "alice@example.test"],
    // client network identity
    ["X-Client-IP", "10.0.0.1"],
    ["X-Original-Forwarded-For", "10.0.0.1"],
    ["CDN-Loop", "cloudflare"],
    // request rewriting
    ["X-HTTP-Method-Override", "DELETE"],
    ["X-HTTP-Method", "DELETE"],
    ["X-Method-Override", "DELETE"],
    ["X-Original-URL", "/v1/files"],
    ["X-Rewrite-URL", "/v1/files"],
  ];

  for (const [name, value] of HARDENED_DROPS) {
    it(`drops ${name}`, () => {
      const out = forwardedLlmRequestHeaders({ [name]: value, "x-vendor-foo": "bar" });
      expect([...out]).toEqual([["x-vendor-foo", "bar"]]);
    });
  }

  // A prefix drop must not swallow a vendor header that merely starts alike.
  it("keeps headers that only resemble a dropped prefix", () => {
    const kept = { "x-goog-user-project": "p", "x-ms-useragent": "u", "cfg-id": "c" };
    expect(Object.fromEntries(forwardedLlmRequestHeaders(kept))).toEqual(kept);
  });
});
