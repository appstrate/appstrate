// SPDX-License-Identifier: Apache-2.0

/**
 * Pure-function tests for the Codex CLI gateway (no DB / upstream).
 */

import { describe, it, expect } from "bun:test";
import {
  buildCodexHeaders,
  codexSubscriptionAuthError,
  deriveCodexSubpath,
} from "../../src/services/llm-proxy/codex-sdk-gateway.ts";
import { gone, internalError } from "../../src/lib/errors.ts";

describe("deriveCodexSubpath", () => {
  it("returns the subpath the CLI appended after the preset", () => {
    expect(deriveCodexSubpath("/api/llm-proxy/codex-sdk/m_1/responses", "m_1")).toBe("/responses");
    expect(deriveCodexSubpath("/api/llm-proxy/codex-sdk/m_1/api/codex/ps/mcp", "m_1")).toBe(
      "/api/codex/ps/mcp",
    );
  });
  it("bare preset path → /", () => {
    expect(deriveCodexSubpath("/api/llm-proxy/codex-sdk/m_1", "m_1")).toBe("/");
  });
});

describe("buildCodexHeaders", () => {
  it("swaps the bearer, stamps the real account id, strips hop headers", () => {
    const incoming = new Headers({
      authorization: "Bearer placeholder",
      "chatgpt-account-id": "00000000-0000-0000-0000-000000000000",
      originator: "codex_exec",
      host: "evil",
      "accept-encoding": "gzip",
      "content-length": "9",
    });
    const out = buildCodexHeaders(incoming, "real-token", "acct-real");
    expect(out.get("authorization")).toBe("Bearer real-token");
    expect(out.get("chatgpt-account-id")).toBe("acct-real");
    expect(out.get("originator")).toBe("codex_exec"); // CLI fingerprint preserved
    expect(out.has("host")).toBe(false);
    expect(out.has("accept-encoding")).toBe(false);
    expect(out.has("content-length")).toBe(false);
  });
  it("leaves account id untouched when none resolved", () => {
    const out = buildCodexHeaders(new Headers({ "chatgpt-account-id": "keep" }), "t", undefined);
    expect(out.get("chatgpt-account-id")).toBe("keep");
  });
});

describe("codexSubscriptionAuthError", () => {
  it("maps a 410 to a 401 auth envelope", () => {
    const res = codexSubscriptionAuthError(gone("gone", "subscription revoked"));
    expect(res?.status).toBe(401);
  });
  it("returns null for any other error", () => {
    expect(codexSubscriptionAuthError(new Error("boom"))).toBeNull();
    expect(codexSubscriptionAuthError(internalError())).toBeNull();
  });
});
