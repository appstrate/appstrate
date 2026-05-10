// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the OAuth identity injection module (SPEC §5.4–5.6):
 *
 *   - `buildIdentityHeaders` returns the expected per-provider headers.
 *   - `transformBody` prepends the Claude Code identity to `system`
 *     across all input shapes (string / array / absent / already-prepended).
 *   - `transformBody` coerces Codex `stream` / `store` flags.
 *   - `adaptBetaHeaderForRetry` strips `context-1m-2025-08-07` only when
 *     the response shape matches the documented pattern.
 */

import { describe, it, expect } from "bun:test";
import { buildIdentityHeaders, transformBody, adaptBetaHeaderForRetry } from "../oauth-identity.ts";
import type { CachedToken } from "../oauth-token-cache.ts";

function makeToken(overrides: Partial<CachedToken> = {}): CachedToken {
  return {
    accessToken: "tok",
    expiresAt: Date.now() + 60_000,
    fetchedAt: Date.now(),
    apiShape: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    providerPackageId: "@appstrate/provider-claude-code",
    ...overrides,
  };
}

describe("buildIdentityHeaders", () => {
  it("returns Claude headers for the Claude Code provider", () => {
    const h = buildIdentityHeaders("@appstrate/provider-claude-code", makeToken());
    expect(h["accept"]).toBe("application/json");
    expect(h["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(h["x-app"]).toBe("cli");
  });

  it("returns Codex headers + chatgpt-account-id when accountId is set", () => {
    const h = buildIdentityHeaders(
      "@appstrate/provider-codex",
      makeToken({
        providerPackageId: "@appstrate/provider-codex",
        apiShape: "openai-responses",
        accountId: "acc_xyz",
      }),
    );
    expect(h["originator"]).toBe("codex_cli_rs");
    expect(h["openai-beta"]).toBe("responses=experimental");
    expect(h["chatgpt-account-id"]).toBe("acc_xyz");
  });

  it("omits chatgpt-account-id when accountId is missing", () => {
    const h = buildIdentityHeaders(
      "@appstrate/provider-codex",
      makeToken({ providerPackageId: "@appstrate/provider-codex" }),
    );
    expect(h["chatgpt-account-id"]).toBeUndefined();
  });

  it("returns an empty object for unknown providers", () => {
    const h = buildIdentityHeaders("@appstrate/provider-unknown", makeToken());
    expect(h).toEqual({});
  });
});

describe("transformBody — Claude identity prepend", () => {
  const PID = "@appstrate/provider-claude-code";
  const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

  it("prepends identity when system is absent", () => {
    const body = JSON.stringify({ model: "claude-opus", messages: [] });
    const out = JSON.parse(transformBody(PID, body));
    expect(out.system).toEqual([{ type: "text", text: IDENTITY }]);
  });

  it("wraps a string system value into an array with identity first", () => {
    const body = JSON.stringify({ system: "You are a helpful assistant.", model: "x" });
    const out = JSON.parse(transformBody(PID, body));
    expect(out.system).toEqual([
      { type: "text", text: IDENTITY },
      { type: "text", text: "You are a helpful assistant." },
    ]);
  });

  it("collapses an identical-string system to a single identity block", () => {
    const body = JSON.stringify({ system: IDENTITY });
    const out = JSON.parse(transformBody(PID, body));
    expect(out.system).toEqual([{ type: "text", text: IDENTITY }]);
  });

  it("prepends identity to an existing array of system blocks", () => {
    const body = JSON.stringify({
      system: [{ type: "text", text: "first existing" }],
    });
    const out = JSON.parse(transformBody(PID, body));
    expect(out.system).toEqual([
      { type: "text", text: IDENTITY },
      { type: "text", text: "first existing" },
    ]);
  });

  it("does not double-prepend if identity is already first", () => {
    const body = JSON.stringify({
      system: [
        { type: "text", text: IDENTITY },
        { type: "text", text: "extra" },
      ],
    });
    const out = JSON.parse(transformBody(PID, body));
    expect(out.system).toEqual([
      { type: "text", text: IDENTITY },
      { type: "text", text: "extra" },
    ]);
  });
});

describe("transformBody — Codex coercion", () => {
  const PID = "@appstrate/provider-codex";

  it("forces stream and store flags when set", () => {
    const body = JSON.stringify({ model: "gpt-5", stream: false, store: true });
    const out = JSON.parse(transformBody(PID, body, { forceStream: true, forceStore: false }));
    expect(out.stream).toBe(true);
    expect(out.store).toBe(false);
  });

  it("leaves flags untouched when options are not provided", () => {
    const body = JSON.stringify({ model: "gpt-5", stream: false, store: true });
    const out = JSON.parse(transformBody(PID, body));
    expect(out.stream).toBe(false);
    expect(out.store).toBe(true);
  });
});

describe("transformBody — defensive paths", () => {
  it("returns input unchanged for empty body", () => {
    expect(transformBody("@appstrate/provider-claude-code", "")).toBe("");
  });

  it("returns input unchanged when body is not JSON", () => {
    expect(transformBody("@appstrate/provider-claude-code", "not-json")).toBe("not-json");
  });

  it("returns input unchanged for unknown providers", () => {
    const body = JSON.stringify({ system: "x" });
    expect(transformBody("@appstrate/provider-unknown", body)).toBe(body);
  });
});

describe("adaptBetaHeaderForRetry", () => {
  it("returns null when status != 400", () => {
    expect(
      adaptBetaHeaderForRetry(429, "out of extra usage", {
        "anthropic-beta": "context-1m-2025-08-07",
      }),
    ).toBeNull();
  });

  it("returns null when body doesn't match the documented patterns", () => {
    expect(
      adaptBetaHeaderForRetry(400, "some other error", {
        "anthropic-beta": "context-1m-2025-08-07",
      }),
    ).toBeNull();
  });

  it("returns null when there's no anthropic-beta header", () => {
    expect(adaptBetaHeaderForRetry(400, "out of extra usage", {})).toBeNull();
  });

  it("returns null when context-1m token is not present in the beta list", () => {
    expect(
      adaptBetaHeaderForRetry(400, "out of extra usage", {
        "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
      }),
    ).toBeNull();
  });

  it("strips context-1m and preserves other tokens", () => {
    const out = adaptBetaHeaderForRetry(400, "out of extra usage", {
      "anthropic-beta": "context-1m-2025-08-07, other-beta-2025-01-01",
    });
    expect(out?.headers["anthropic-beta"]).toBe("other-beta-2025-01-01");
  });

  it("removes the header entirely when context-1m was the only token", () => {
    const out = adaptBetaHeaderForRetry(400, "out of extra usage", {
      "anthropic-beta": "context-1m-2025-08-07",
    });
    expect(out?.headers["anthropic-beta"]).toBeUndefined();
  });

  it("matches case-insensitive header keys", () => {
    const out = adaptBetaHeaderForRetry(400, "long context beta not available", {
      "Anthropic-Beta": "context-1m-2025-08-07, other",
    });
    expect(out?.headers["Anthropic-Beta"]).toBe("other");
  });
});
