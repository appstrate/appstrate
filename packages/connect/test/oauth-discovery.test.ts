// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { resolveOAuthEndpoints, __clearOAuthDiscoveryCache } from "../src/oauth-discovery.ts";

beforeEach(() => {
  // Reset the per-issuer discovery cache so each test sees a clean slate.
  __clearOAuthDiscoveryCache();
});

function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("resolveOAuthEndpoints — discovery vs manual", () => {
  it("returns manual endpoints unchanged (manual wins over discovery — AFPS §7.3)", async () => {
    // Per AFPS §7.3 + M4 enrichment: discovery DOES run when issuer is
    // declared (to project userinfo / PKCE caps), but manual endpoints are
    // authoritative — the discovered values must never override them.
    const result = await withFetch(
      (async () =>
        jsonResponse({
          issuer: "https://idp.example.com",
          authorization_endpoint: "https://disco/authorize",
          token_endpoint: "https://disco/token",
        })) as unknown as typeof fetch,
      () =>
        resolveOAuthEndpoints({
          issuer: "https://idp.example.com",
          authorizationEndpoint: "https://idp.example.com/authorize",
          tokenEndpoint: "https://idp.example.com/token",
        }),
    );
    expect(result.authorizationEndpoint).toBe("https://idp.example.com/authorize");
    expect(result.tokenEndpoint).toBe("https://idp.example.com/token");
  });

  it("skips discovery entirely when no issuer is declared", async () => {
    let called = false;
    const result = await withFetch(
      (async () => {
        called = true;
        return jsonResponse({});
      }) as unknown as typeof fetch,
      () => resolveOAuthEndpoints({ authorizationEndpoint: "https://idp/authorize" }),
    );
    expect(called).toBe(false);
    expect(result.authorizationEndpoint).toBe("https://idp/authorize");
    expect(result.tokenEndpoint).toBeUndefined();
  });

  it("fetches the discovery document and fills both endpoints", async () => {
    const seen: string[] = [];
    const result = await withFetch(
      (async (input: Request | URL | string) => {
        seen.push(String(input));
        return jsonResponse({
          issuer: "https://idp.example.com",
          authorization_endpoint: "https://idp.example.com/oauth/authorize",
          token_endpoint: "https://idp.example.com/oauth/token",
        });
      }) as unknown as typeof fetch,
      () => resolveOAuthEndpoints({ issuer: "https://idp.example.com" }),
    );
    // First probe per AFPS §7.3 is RFC 8414 path-insertion.
    expect(seen[0]).toBe("https://idp.example.com/.well-known/oauth-authorization-server");
    expect(result.authorizationEndpoint).toBe("https://idp.example.com/oauth/authorize");
    expect(result.tokenEndpoint).toBe("https://idp.example.com/oauth/token");
  });

  it("trims a trailing slash on the issuer before joining the well-known suffix", async () => {
    const seen: string[] = [];
    await withFetch(
      (async (input: Request | URL | string) => {
        seen.push(String(input));
        return jsonResponse({
          issuer: "https://idp.example.com",
          authorization_endpoint: "https://idp/authorize",
          token_endpoint: "https://idp/token",
        });
      }) as unknown as typeof fetch,
      () => resolveOAuthEndpoints({ issuer: "https://idp.example.com/" }),
    );
    expect(seen[0]).toBe("https://idp.example.com/.well-known/oauth-authorization-server");
  });

  it("falls back through the three §7.3 probes when earlier ones 404", async () => {
    const seen: string[] = [];
    const result = await withFetch(
      (async (input: Request | URL | string) => {
        const url = String(input);
        seen.push(url);
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return new Response("not found", { status: 404 });
        }
        return jsonResponse({
          issuer: "https://idp.example.com",
          authorization_endpoint: "https://idp/oidc/authorize",
          token_endpoint: "https://idp/oidc/token",
        });
      }) as unknown as typeof fetch,
      () => resolveOAuthEndpoints({ issuer: "https://idp.example.com" }),
    );
    expect(seen).toEqual([
      "https://idp.example.com/.well-known/oauth-authorization-server",
      "https://idp.example.com/.well-known/openid-configuration",
    ]);
    expect(result.authorizationEndpoint).toBe("https://idp/oidc/authorize");
    expect(result.tokenEndpoint).toBe("https://idp/oidc/token");
  });

  it("preserves a manual endpoint and only fills the missing one from discovery", async () => {
    const result = await withFetch(
      (async () =>
        jsonResponse({
          issuer: "https://idp.example.com",
          authorization_endpoint: "https://disco/authorize",
          token_endpoint: "https://disco/token",
        })) as unknown as typeof fetch,
      () =>
        resolveOAuthEndpoints({
          issuer: "https://idp.example.com",
          authorizationEndpoint: "https://manual/authorize",
        }),
    );
    // Manual authorize wins; token is filled from discovery.
    expect(result.authorizationEndpoint).toBe("https://manual/authorize");
    expect(result.tokenEndpoint).toBe("https://disco/token");
  });

  it("projects code_challenge_methods_supported from the discovery document (RFC 8414 §2)", async () => {
    const result = await withFetch(
      (async () =>
        jsonResponse({
          issuer: "https://idp.example.com",
          authorization_endpoint: "https://idp/authorize",
          token_endpoint: "https://idp/token",
          code_challenge_methods_supported: ["S256", "plain"],
        })) as unknown as typeof fetch,
      () => resolveOAuthEndpoints({ issuer: "https://idp.example.com" }),
    );
    expect(result.codeChallengeMethodsSupported).toEqual(["S256", "plain"]);
  });

  it("leaves codeChallengeMethodsSupported undefined when the discovery document omits the field", async () => {
    const result = await withFetch(
      (async () =>
        jsonResponse({
          issuer: "https://idp.example.com",
          authorization_endpoint: "https://idp/authorize",
          token_endpoint: "https://idp/token",
        })) as unknown as typeof fetch,
      () => resolveOAuthEndpoints({ issuer: "https://idp.example.com" }),
    );
    expect(result.codeChallengeMethodsSupported).toBeUndefined();
  });

  it("ignores a malformed code_challenge_methods_supported (not a string array)", async () => {
    const result = await withFetch(
      (async () =>
        jsonResponse({
          issuer: "https://idp.example.com",
          authorization_endpoint: "https://idp/authorize",
          token_endpoint: "https://idp/token",
          code_challenge_methods_supported: [1, 2, 3],
        })) as unknown as typeof fetch,
      () => resolveOAuthEndpoints({ issuer: "https://idp.example.com" }),
    );
    expect(result.codeChallengeMethodsSupported).toBeUndefined();
  });

  it("projects userinfo_endpoint from the discovery document (OIDC Discovery 1.0)", async () => {
    const result = await withFetch(
      (async () =>
        jsonResponse({
          issuer: "https://idp.example.com",
          authorization_endpoint: "https://idp/authorize",
          token_endpoint: "https://idp/token",
          userinfo_endpoint: "https://idp.example.com/userinfo",
        })) as unknown as typeof fetch,
      () => resolveOAuthEndpoints({ issuer: "https://idp.example.com" }),
    );
    expect(result.userinfoEndpoint).toBe("https://idp.example.com/userinfo");
  });

  it("leaves userinfoEndpoint undefined when the discovery document omits the field", async () => {
    const result = await withFetch(
      (async () =>
        jsonResponse({
          issuer: "https://idp.example.com",
          authorization_endpoint: "https://idp/authorize",
          token_endpoint: "https://idp/token",
        })) as unknown as typeof fetch,
      () => resolveOAuthEndpoints({ issuer: "https://idp.example.com" }),
    );
    expect(result.userinfoEndpoint).toBeUndefined();
  });

  it("ignores a malformed userinfo_endpoint (not a string URL)", async () => {
    const result = await withFetch(
      (async () =>
        jsonResponse({
          issuer: "https://idp.example.com",
          authorization_endpoint: "https://idp/authorize",
          token_endpoint: "https://idp/token",
          userinfo_endpoint: 42,
        })) as unknown as typeof fetch,
      () => resolveOAuthEndpoints({ issuer: "https://idp.example.com" }),
    );
    expect(result.userinfoEndpoint).toBeUndefined();
  });

  it("ignores a userinfo_endpoint that isn't a well-formed URL", async () => {
    const result = await withFetch(
      (async () =>
        jsonResponse({
          issuer: "https://idp.example.com",
          authorization_endpoint: "https://idp/authorize",
          token_endpoint: "https://idp/token",
          userinfo_endpoint: "not a url",
        })) as unknown as typeof fetch,
      () => resolveOAuthEndpoints({ issuer: "https://idp.example.com" }),
    );
    expect(result.userinfoEndpoint).toBeUndefined();
  });

  it("probes the three §7.3 paths in order for a realm-style issuer", async () => {
    const seen: string[] = [];
    const result = await withFetch(
      (async (input: Request | URL | string) => {
        const url = String(input);
        seen.push(url);
        // Only the third (path-append) succeeds — exercises all three probes.
        if (url === "https://auth.example.com/realms/foo/.well-known/openid-configuration") {
          return jsonResponse({
            issuer: "https://auth.example.com/realms/foo",
            authorization_endpoint:
              "https://auth.example.com/realms/foo/protocol/openid-connect/auth",
            token_endpoint: "https://auth.example.com/realms/foo/protocol/openid-connect/token",
          });
        }
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch,
      () => resolveOAuthEndpoints({ issuer: "https://auth.example.com/realms/foo" }),
    );
    expect(seen).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/realms/foo",
      "https://auth.example.com/.well-known/openid-configuration/realms/foo",
      "https://auth.example.com/realms/foo/.well-known/openid-configuration",
    ]);
    expect(result.authorizationEndpoint).toBe(
      "https://auth.example.com/realms/foo/protocol/openid-connect/auth",
    );
    expect(result.tokenEndpoint).toBe(
      "https://auth.example.com/realms/foo/protocol/openid-connect/token",
    );
  });

  it("rejects a discovery doc whose issuer member doesn't match the configured issuer (§7.3)", async () => {
    const seen: string[] = [];
    const result = await withFetch(
      (async (input: Request | URL | string) => {
        const url = String(input);
        seen.push(url);
        if (url === "https://accounts.example.com/.well-known/oauth-authorization-server") {
          // Hostile / misconfigured doc — issuer mismatch.
          return jsonResponse({
            issuer: "https://evil.example.com",
            authorization_endpoint: "https://evil.example.com/authorize",
            token_endpoint: "https://evil.example.com/token",
          });
        }
        if (url === "https://accounts.example.com/.well-known/openid-configuration") {
          return jsonResponse({
            issuer: "https://accounts.example.com",
            authorization_endpoint: "https://accounts.example.com/oauth/authorize",
            token_endpoint: "https://accounts.example.com/oauth/token",
          });
        }
        return new Response("not found", { status: 404 });
      }) as unknown as typeof fetch,
      () => resolveOAuthEndpoints({ issuer: "https://accounts.example.com" }),
    );
    // Both probes were attempted (first rejected on issuer mismatch).
    expect(seen[0]).toBe("https://accounts.example.com/.well-known/oauth-authorization-server");
    expect(seen[1]).toBe("https://accounts.example.com/.well-known/openid-configuration");
    // Endpoints come from the legitimate second probe, NOT the rejected first.
    expect(result.authorizationEndpoint).toBe("https://accounts.example.com/oauth/authorize");
    expect(result.tokenEndpoint).toBe("https://accounts.example.com/oauth/token");
  });

  it("swallows a network failure and returns the (partial) manual set", async () => {
    const result = await withFetch(
      (async () => {
        throw new TypeError("ConnectionRefused");
      }) as unknown as typeof fetch,
      () =>
        resolveOAuthEndpoints({
          issuer: "https://idp.example.com",
          tokenEndpoint: "https://manual/token",
        }),
    );
    expect(result.tokenEndpoint).toBe("https://manual/token");
    expect(result.authorizationEndpoint).toBeUndefined();
  });

  // ─── M4 — enrichment when both endpoints are manually declared ───
  // AFPS §7.3 keeps discovery as enrichment. When the manifest declares both
  // endpoints AND the issuer, discovery MUST still run so callers learn the
  // IdP's `userinfo_endpoint` + `code_challenge_methods_supported`. Manual
  // endpoints stay authoritative.

  it("enriches with userinfo_endpoint when both endpoints are manual + discovery succeeds", async () => {
    const result = await withFetch(
      (async () =>
        jsonResponse({
          issuer: "https://idp.example.com",
          // Discovery declares its own endpoints — the manual ones MUST win.
          authorization_endpoint: "https://disco/authorize",
          token_endpoint: "https://disco/token",
          userinfo_endpoint: "https://idp.example.com/userinfo",
          code_challenge_methods_supported: ["S256"],
        })) as unknown as typeof fetch,
      () =>
        resolveOAuthEndpoints({
          issuer: "https://idp.example.com",
          authorizationEndpoint: "https://manual/authorize",
          tokenEndpoint: "https://manual/token",
        }),
    );
    // Manual endpoints win.
    expect(result.authorizationEndpoint).toBe("https://manual/authorize");
    expect(result.tokenEndpoint).toBe("https://manual/token");
    // Enrichment fields surface from discovery.
    expect(result.userinfoEndpoint).toBe("https://idp.example.com/userinfo");
    expect(result.codeChallengeMethodsSupported).toEqual(["S256"]);
  });

  it("falls back silently to manual endpoints when discovery fails", async () => {
    const result = await withFetch(
      (async () => {
        throw new TypeError("ConnectionRefused");
      }) as unknown as typeof fetch,
      () =>
        resolveOAuthEndpoints({
          issuer: "https://idp.example.com",
          authorizationEndpoint: "https://manual/authorize",
          tokenEndpoint: "https://manual/token",
        }),
    );
    // No error thrown; manual endpoints preserved unchanged.
    expect(result.authorizationEndpoint).toBe("https://manual/authorize");
    expect(result.tokenEndpoint).toBe("https://manual/token");
    // No enrichment available — fields undefined.
    expect(result.userinfoEndpoint).toBeUndefined();
    expect(result.codeChallengeMethodsSupported).toBeUndefined();
  });

  it("caches discovery results per issuer — second call hits cache, no further fetches", async () => {
    let fetchCountBeforeSecondCall = 0;
    let fetchCountAfterSecondCall = 0;
    let secondCallStarted = false;
    await withFetch(
      (async () => {
        if (secondCallStarted) fetchCountAfterSecondCall += 1;
        else fetchCountBeforeSecondCall += 1;
        return jsonResponse({
          issuer: "https://idp.example.com",
          authorization_endpoint: "https://idp.example.com/oauth/authorize",
          token_endpoint: "https://idp.example.com/oauth/token",
          userinfo_endpoint: "https://idp.example.com/userinfo",
          code_challenge_methods_supported: ["S256"],
        });
      }) as unknown as typeof fetch,
      async () => {
        const r1 = await resolveOAuthEndpoints({ issuer: "https://idp.example.com" });
        secondCallStarted = true;
        const r2 = await resolveOAuthEndpoints({ issuer: "https://idp.example.com" });
        expect(r1.userinfoEndpoint).toBe("https://idp.example.com/userinfo");
        expect(r2.userinfoEndpoint).toBe("https://idp.example.com/userinfo");
      },
    );
    // First call: at least one fetch (could be 1+ if probes 404 first).
    expect(fetchCountBeforeSecondCall).toBeGreaterThanOrEqual(1);
    // Second call: served entirely from cache, zero further fetches.
    expect(fetchCountAfterSecondCall).toBe(0);
  });
});
