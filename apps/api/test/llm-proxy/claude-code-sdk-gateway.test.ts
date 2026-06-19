// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  deriveUpstreamSubpath,
  buildSubscriptionHeaders,
} from "../../src/services/llm-proxy/claude-code-sdk-gateway.ts";

describe("deriveUpstreamSubpath", () => {
  const preset = "11111111-1111-1111-1111-111111111111";

  test("extracts the path the SDK appended after the preset segment", () => {
    expect(
      deriveUpstreamSubpath(`/api/llm-proxy/claude-code-sdk/${preset}/v1/messages`, preset),
    ).toBe("/v1/messages");
    expect(
      deriveUpstreamSubpath(
        `/api/llm-proxy/claude-code-sdk/${preset}/v1/messages/count_tokens`,
        preset,
      ),
    ).toBe("/v1/messages/count_tokens");
  });

  test("falls back to /v1/messages for the bare preset path", () => {
    expect(deriveUpstreamSubpath(`/api/llm-proxy/claude-code-sdk/${preset}`, preset)).toBe(
      "/v1/messages",
    );
  });

  test("falls back when the prefix is absent (defensive)", () => {
    expect(deriveUpstreamSubpath("/something/else", preset)).toBe("/v1/messages");
  });
});

describe("buildSubscriptionHeaders", () => {
  test("swaps in the real Bearer token, replacing the placeholder loopback bearer", () => {
    const incoming = new Headers({ authorization: "Bearer chatloop_placeholder" });
    const out = buildSubscriptionHeaders(incoming, "sk-ant-oat-REAL");
    expect(out.get("authorization")).toBe("Bearer sk-ant-oat-REAL");
  });

  test("adds the OAuth beta, merging with caller betas (de-duplicated)", () => {
    const incoming = new Headers({
      "anthropic-beta": "prompt-caching-2024-07-31, oauth-2025-04-20",
    });
    const out = buildSubscriptionHeaders(incoming, "tok");
    const betas = (out.get("anthropic-beta") ?? "").split(",").map((s) => s.trim());
    expect(betas).toContain("prompt-caching-2024-07-31");
    expect(betas.filter((b) => b === "oauth-2025-04-20")).toHaveLength(1);
  });

  test("injects the OAuth beta when the caller sent none", () => {
    const out = buildSubscriptionHeaders(new Headers(), "tok");
    expect(out.get("anthropic-beta")).toBe("oauth-2025-04-20");
  });

  test("defaults anthropic-version but preserves a caller-supplied one", () => {
    expect(buildSubscriptionHeaders(new Headers(), "tok").get("anthropic-version")).toBe(
      "2023-06-01",
    );
    const pinned = buildSubscriptionHeaders(
      new Headers({ "anthropic-version": "2099-01-01" }),
      "tok",
    );
    expect(pinned.get("anthropic-version")).toBe("2099-01-01");
  });

  test("strips x-api-key, host, content-length, accept-encoding", () => {
    const incoming = new Headers({
      "x-api-key": "leak",
      host: "127.0.0.1:3000",
      "content-length": "123",
      "accept-encoding": "gzip",
    });
    const out = buildSubscriptionHeaders(incoming, "tok");
    expect(out.get("x-api-key")).toBeNull();
    expect(out.get("host")).toBeNull();
    expect(out.get("content-length")).toBeNull();
    expect(out.get("accept-encoding")).toBeNull();
  });

  test("never leaks the real token via x-api-key", () => {
    const out = buildSubscriptionHeaders(new Headers({ "x-api-key": "old" }), "secret-token");
    const serialized = JSON.stringify([...out.entries()]);
    expect(serialized).not.toContain("x-api-key");
    expect(out.get("authorization")).toContain("secret-token");
  });
});
