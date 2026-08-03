// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the shared credential-proxy primitives.
 * These must match the behaviour both the credential-proxy route and
 * the in-container sidecar rely on — any change here affects both
 * entrypoints simultaneously.
 */

import { describe, it, expect } from "bun:test";
import {
  substituteVars,
  findUnresolvedPlaceholders,
  matchesAuthorizedUriSpec,
  HOP_BY_HOP_HEADERS,
  filterHeaders,
  buildInjectedCredentialHeader,
  applyInjectedCredentialHeader,
  applyInjectedCredentialHeaderToHeaders,
  normalizeAuthSchemeTemplate,
  normalizeAuthSchemeTemplates,
} from "../src/proxy-primitives.ts";

describe("substituteVars", () => {
  it("replaces known placeholders", () => {
    expect(substituteVars("Bearer {{token}}", { token: "abc" })).toBe("Bearer abc");
  });

  it("tolerates whitespace inside braces", () => {
    expect(substituteVars("X: {{ token }}", { token: "abc" })).toBe("X: abc");
  });

  it("leaves unknown placeholders intact (fail-closed friendly)", () => {
    expect(substituteVars("{{unknown}}", {})).toBe("{{unknown}}");
  });

  it("handles multiple placeholders in one string", () => {
    expect(substituteVars("{{a}}/{{b}}", { a: "1", b: "2" })).toBe("1/2");
  });

  it("returns input unchanged when no placeholders are present", () => {
    expect(substituteVars("plain text", { x: "y" })).toBe("plain text");
  });

  it("does not replace partial matches", () => {
    // Single braces, missing closing, etc. — untouched
    expect(substituteVars("{token}", { token: "abc" })).toBe("{token}");
    expect(substituteVars("{{token", { token: "abc" })).toBe("{{token");
  });

  it("handles empty string input", () => {
    expect(substituteVars("", { x: "y" })).toBe("");
  });

  it("permits empty-string credential values", () => {
    expect(substituteVars("X={{empty}}", { empty: "" })).toBe("X=");
  });
});

describe("findUnresolvedPlaceholders", () => {
  it("returns [] when every placeholder resolves", () => {
    const substituted = substituteVars("{{a}}{{b}}", { a: "1", b: "2" });
    expect(findUnresolvedPlaceholders(substituted)).toEqual([]);
  });

  it("lists placeholder names that remain", () => {
    expect(findUnresolvedPlaceholders("{{a}}/{{b}}")).toEqual(["a", "b"]);
  });

  it("returns duplicates as they appear (caller dedups if needed)", () => {
    expect(findUnresolvedPlaceholders("{{x}}{{x}}")).toEqual(["x", "x"]);
  });

  it("tolerates whitespace", () => {
    expect(findUnresolvedPlaceholders("{{ a }}")).toEqual(["a"]);
  });
});

describe("matchesAuthorizedUriSpec (AFPS semantics)", () => {
  it("matches an exact URL", () => {
    expect(
      matchesAuthorizedUriSpec(
        "https://api.example.com/v1/messages",
        "https://api.example.com/v1/messages",
      ),
    ).toBe(true);
  });

  it("rejects a URL that doesn't match the pattern", () => {
    expect(
      matchesAuthorizedUriSpec(
        "https://api.example.com/v1/messages",
        "https://api.example.com/v2/messages",
      ),
    ).toBe(false);
  });

  it("`*` matches a single path segment only", () => {
    expect(
      matchesAuthorizedUriSpec(
        "https://api.example.com/v1/*/messages",
        "https://api.example.com/v1/abc/messages",
      ),
    ).toBe(true);
    expect(
      matchesAuthorizedUriSpec(
        "https://api.example.com/v1/*/messages",
        "https://api.example.com/v1/a/b/messages",
      ),
    ).toBe(false);
  });

  it("`**` matches any substring including slashes", () => {
    expect(
      matchesAuthorizedUriSpec(
        "https://api.example.com/v1/**/messages",
        "https://api.example.com/v1/a/b/c/messages",
      ),
    ).toBe(true);
  });

  it("escapes regex metacharacters in the pattern", () => {
    // Dots must be literal, not wildcards.
    expect(
      matchesAuthorizedUriSpec("https://api.example.com/v1", "https://apiXexample.com/v1"),
    ).toBe(false);
  });

  it("does not allow partial match without wildcard", () => {
    expect(
      matchesAuthorizedUriSpec("https://api.example.com/v1", "https://api.example.com/v1/foo"),
    ).toBe(false);
  });
});

describe("HOP_BY_HOP_HEADERS + filterHeaders", () => {
  it("includes the canonical RFC 7230 hop-by-hop set", () => {
    for (const h of [
      "connection",
      "keep-alive",
      "proxy-connection",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]) {
      expect(HOP_BY_HOP_HEADERS.has(h)).toBe(true);
    }
  });

  it("strips host and content-length", () => {
    const out = filterHeaders({
      host: "x",
      "content-length": "10",
      "x-keep": "yes",
    });
    expect(out).toEqual({ "x-keep": "yes" });
  });

  it("strips hop-by-hop headers regardless of casing", () => {
    const out = filterHeaders({
      Connection: "close",
      "Keep-Alive": "timeout=5",
      "X-Keep": "yes",
    });
    expect(out).toEqual({ "X-Keep": "yes" });
  });

  it("honours extraSkip (lowercase keys)", () => {
    const out = filterHeaders(
      {
        "x-integration": "gmail",
        "x-keep": "yes",
      },
      new Set(["x-integration"]),
    );
    expect(out).toEqual({ "x-keep": "yes" });
  });

  it("preserves original casing of kept headers", () => {
    const out = filterHeaders({ Authorization: "Bearer abc" });
    expect(out).toEqual({ Authorization: "Bearer abc" });
  });
});

describe("buildInjectedCredentialHeader", () => {
  it("builds `Bearer <token>` when prefix is set", () => {
    const out = buildInjectedCredentialHeader({
      credentials: { access_token: "abc" },
      credentialHeaderName: "Authorization",
      credentialHeaderPrefix: "Bearer",
      credentialFieldName: "access_token",
    });
    expect(out).toEqual({ name: "Authorization", value: "Bearer abc" });
  });

  it("keeps a composite Authorization prefix literal", () => {
    const out = buildInjectedCredentialHeader({
      credentials: { api_key: "abc" },
      credentialHeaderName: "Authorization",
      credentialHeaderPrefix: "Token token=",
      credentialFieldName: "api_key",
    });
    expect(out).toEqual({ name: "Authorization", value: "Token token=abc" });
  });

  it("omits the space when no prefix", () => {
    const out = buildInjectedCredentialHeader({
      credentials: { api_key: "secret" },
      credentialHeaderName: "X-Api-Key",
      credentialFieldName: "api_key",
    });
    expect(out).toEqual({ name: "X-Api-Key", value: "secret" });
  });

  it("returns undefined when header name is absent (no injection)", () => {
    expect(
      buildInjectedCredentialHeader({
        credentials: { access_token: "abc" },
        credentialFieldName: "access_token",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the referenced field is empty", () => {
    expect(
      buildInjectedCredentialHeader({
        credentials: { access_token: "" },
        credentialHeaderName: "Authorization",
        credentialFieldName: "access_token",
      }),
    ).toBeUndefined();
  });
});

describe("applyInjectedCredentialHeader (record)", () => {
  it("adds the header when absent", () => {
    const headers: Record<string, string> = {};
    applyInjectedCredentialHeader(headers, {
      credentials: { access_token: "abc" },
      credentialHeaderName: "Authorization",
      credentialHeaderPrefix: "Bearer",
      credentialFieldName: "access_token",
    });
    expect(headers).toEqual({ Authorization: "Bearer abc" });
  });

  it("replaces a case-insensitive caller header by default", () => {
    const headers: Record<string, string> = { authorization: "Bearer caller" };
    applyInjectedCredentialHeader(headers, {
      credentials: { access_token: "server" },
      credentialHeaderName: "Authorization",
      credentialHeaderPrefix: "Bearer",
      credentialFieldName: "access_token",
    });
    expect(headers).toEqual({ Authorization: "Bearer server" });
  });

  it("respects a case-insensitive caller override when explicitly allowed", () => {
    const headers: Record<string, string> = { authorization: "Bearer caller" };
    const decision = applyInjectedCredentialHeader(headers, {
      credentials: { access_token: "server" },
      credentialHeaderName: "Authorization",
      credentialHeaderPrefix: "Bearer",
      credentialAllowServerOverride: true,
      credentialFieldName: "access_token",
    });
    expect(headers).toEqual({ authorization: "Bearer caller" });
    expect(decision).toEqual({ kind: "caller_override", headerName: "Authorization" });
  });
});

describe("applyInjectedCredentialHeaderToHeaders (Headers instance)", () => {
  it("adds the header when absent", () => {
    const headers = new Headers();
    applyInjectedCredentialHeaderToHeaders(headers, {
      credentials: { access_token: "abc" },
      credentialHeaderName: "Authorization",
      credentialHeaderPrefix: "Bearer",
      credentialFieldName: "access_token",
    });
    expect(headers.get("authorization")).toBe("Bearer abc");
  });

  it("replaces a case-insensitive caller header by default", () => {
    const headers = new Headers({ Authorization: "Bearer caller" });
    applyInjectedCredentialHeaderToHeaders(headers, {
      credentials: { access_token: "server" },
      credentialHeaderName: "Authorization",
      credentialHeaderPrefix: "Bearer",
      credentialFieldName: "access_token",
    });
    expect(headers.get("authorization")).toBe("Bearer server");
  });

  it("respects a case-insensitive caller override when explicitly allowed", () => {
    const headers = new Headers({ Authorization: "Bearer caller" });
    const decision = applyInjectedCredentialHeaderToHeaders(headers, {
      credentials: { access_token: "server" },
      credentialHeaderName: "Authorization",
      credentialHeaderPrefix: "Bearer",
      credentialAllowServerOverride: true,
      credentialFieldName: "access_token",
    });
    expect(headers.get("authorization")).toBe("Bearer caller");
    expect(decision).toEqual({ kind: "caller_override", headerName: "Authorization" });
  });
});

describe("normalizeAuthSchemeTemplate", () => {
  it("adds a space between the scheme and a placeholder", () => {
    expect(normalizeAuthSchemeTemplate("Authorization", "Bearer{{access_token}}")).toBe(
      "Bearer {{access_token}}",
    );
  });

  it("handles Basic and Token schemes", () => {
    expect(normalizeAuthSchemeTemplate("Authorization", "Basic{{creds}}")).toBe("Basic {{creds}}");
    expect(normalizeAuthSchemeTemplate("Authorization", "Token{{api_key}}")).toBe(
      "Token {{api_key}}",
    );
  });

  it("is case-insensitive on the scheme and preserves the caller's casing", () => {
    expect(normalizeAuthSchemeTemplate("Authorization", "bearer{{access_token}}")).toBe(
      "bearer {{access_token}}",
    );
  });

  it("leaves well-formed templates untouched", () => {
    expect(normalizeAuthSchemeTemplate("Authorization", "Bearer {{access_token}}")).toBe(
      "Bearer {{access_token}}",
    );
  });

  it("normalises Proxy-Authorization too", () => {
    expect(normalizeAuthSchemeTemplate("Proxy-Authorization", "Basic{{creds}}")).toBe(
      "Basic {{creds}}",
    );
  });

  it("matches the header name case-insensitively", () => {
    expect(normalizeAuthSchemeTemplate("authorization", "Bearer{{t}}")).toBe("Bearer {{t}}");
  });

  it("leaves non-auth headers untouched", () => {
    expect(normalizeAuthSchemeTemplate("X-Custom", "Bearer{{t}}")).toBe("Bearer{{t}}");
  });

  // ─── #988 regressions ────────────────────────────────────────────────
  // The repair is anchored on `{{`, so a literal secret can never be
  // rewritten. These are the exact values that the old resolved-value
  // regex corrupted into a 401.
  it("does not touch a raw secret that starts with a scheme name", () => {
    expect(normalizeAuthSchemeTemplate("Authorization", "basically_a_key_123")).toBe(
      "basically_a_key_123",
    );
    expect(normalizeAuthSchemeTemplate("Authorization", "tokenlive_sk_123")).toBe(
      "tokenlive_sk_123",
    );
    expect(normalizeAuthSchemeTemplate("Authorization", "bearerXYZ")).toBe("bearerXYZ");
  });

  it("does not touch a bare placeholder resolving to a scheme-prefixed secret", () => {
    expect(normalizeAuthSchemeTemplate("Authorization", "{{api_key}}")).toBe("{{api_key}}");
  });
});

describe("normalizeAuthSchemeTemplates (record)", () => {
  it("repairs auth headers and passes the rest through", () => {
    expect(
      normalizeAuthSchemeTemplates({
        Authorization: "Bearer{{access_token}}",
        "X-Custom": "Bearer{{t}}",
        Accept: "application/json",
      }),
    ).toEqual({
      Authorization: "Bearer {{access_token}}",
      "X-Custom": "Bearer{{t}}",
      Accept: "application/json",
    });
  });

  it("does not mutate the caller's record", () => {
    const input = { Authorization: "Bearer{{access_token}}" };
    const out = normalizeAuthSchemeTemplates(input);
    expect(input).toEqual({ Authorization: "Bearer{{access_token}}" });
    expect(out).toEqual({ Authorization: "Bearer {{access_token}}" });
  });
});
