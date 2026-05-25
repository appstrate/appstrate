// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { resolveOAuthEndpoints } from "../src/oauth-discovery.ts";

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
  it("returns manual endpoints unchanged without any fetch when both are present", async () => {
    let called = false;
    const result = await withFetch(
      (async () => {
        called = true;
        return jsonResponse({});
      }) as unknown as typeof fetch,
      () =>
        resolveOAuthEndpoints({
          issuer: "https://idp.example.com",
          authorizationEndpoint: "https://idp.example.com/authorize",
          tokenEndpoint: "https://idp.example.com/token",
        }),
    );
    expect(called).toBe(false);
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

  it("fetches the OIDC well-known document and fills both endpoints", async () => {
    const seen: string[] = [];
    const result = await withFetch(
      (async (input: Request | URL | string) => {
        seen.push(String(input));
        return jsonResponse({
          authorization_endpoint: "https://idp.example.com/oauth/authorize",
          token_endpoint: "https://idp.example.com/oauth/token",
        });
      }) as unknown as typeof fetch,
      () => resolveOAuthEndpoints({ issuer: "https://idp.example.com" }),
    );
    expect(seen[0]).toBe("https://idp.example.com/.well-known/openid-configuration");
    expect(result.authorizationEndpoint).toBe("https://idp.example.com/oauth/authorize");
    expect(result.tokenEndpoint).toBe("https://idp.example.com/oauth/token");
  });

  it("trims a trailing slash on the issuer before joining the well-known suffix", async () => {
    const seen: string[] = [];
    await withFetch(
      (async (input: Request | URL | string) => {
        seen.push(String(input));
        return jsonResponse({
          authorization_endpoint: "https://idp/authorize",
          token_endpoint: "https://idp/token",
        });
      }) as unknown as typeof fetch,
      () => resolveOAuthEndpoints({ issuer: "https://idp.example.com/" }),
    );
    expect(seen[0]).toBe("https://idp.example.com/.well-known/openid-configuration");
  });

  it("falls back to the RFC 8414 oauth-authorization-server path when OIDC 404s", async () => {
    const seen: string[] = [];
    const result = await withFetch(
      (async (input: Request | URL | string) => {
        const url = String(input);
        seen.push(url);
        if (url.endsWith("/openid-configuration")) {
          return new Response("not found", { status: 404 });
        }
        return jsonResponse({
          authorization_endpoint: "https://idp/8414/authorize",
          token_endpoint: "https://idp/8414/token",
        });
      }) as unknown as typeof fetch,
      () => resolveOAuthEndpoints({ issuer: "https://idp.example.com" }),
    );
    expect(seen).toEqual([
      "https://idp.example.com/.well-known/openid-configuration",
      "https://idp.example.com/.well-known/oauth-authorization-server",
    ]);
    expect(result.authorizationEndpoint).toBe("https://idp/8414/authorize");
    expect(result.tokenEndpoint).toBe("https://idp/8414/token");
  });

  it("preserves a manual endpoint and only fills the missing one from discovery", async () => {
    const result = await withFetch(
      (async () =>
        jsonResponse({
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
});
