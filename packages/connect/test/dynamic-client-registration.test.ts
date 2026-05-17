// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { DcrError, registerClient, type DcrFetchFn } from "../src/dynamic-client-registration.ts";

describe("registerClient — happy path", () => {
  it("POSTs the request and returns the AS response", async () => {
    const received: Array<{ url: string; body: string }> = [];
    const fetchFn: DcrFetchFn = async (url, body) => {
      received.push({ url, body });
      return {
        status: 201,
        body: {
          client_id: "dyn-client-1",
          client_secret: "secret",
          client_id_issued_at: 1700000000,
          registration_access_token: "rat-xyz",
        },
      };
    };
    const result = await registerClient({
      registrationEndpoint: "https://as.example/oauth/register",
      request: { redirect_uris: ["https://app.example/cb"], client_name: "Test" },
      fetch: fetchFn,
    });
    expect(result.client_id).toBe("dyn-client-1");
    expect(result.client_secret).toBe("secret");
    expect(received.length).toBe(1);
    const parsed = JSON.parse(received[0]!.body) as Record<string, unknown>;
    expect(parsed.redirect_uris).toEqual(["https://app.example/cb"]);
    expect(parsed.client_name).toBe("Test");
    // Defaults present.
    expect(parsed.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(parsed.response_types).toEqual(["code"]);
    expect(parsed.token_endpoint_auth_method).toBe("none");
    expect(parsed.software_id).toBe("appstrate-runtime");
  });

  it("allows the caller to override defaults", async () => {
    let body!: string;
    const fetchFn: DcrFetchFn = async (_url, b) => {
      body = b;
      return { status: 200, body: { client_id: "x" } };
    };
    await registerClient({
      registrationEndpoint: "https://as.example/register",
      request: {
        redirect_uris: ["https://x/cb"],
        token_endpoint_auth_method: "client_secret_post",
        software_id: "custom",
      },
      fetch: fetchFn,
    });
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed.token_endpoint_auth_method).toBe("client_secret_post");
    expect(parsed.software_id).toBe("custom");
  });
});

describe("registerClient — failure paths", () => {
  it("INVALID_REGISTRATION_URL on non-URL", async () => {
    await expectDcrError(
      () =>
        registerClient({
          registrationEndpoint: "not a url",
          request: { redirect_uris: ["https://x/cb"] },
          fetch: async () => ({ status: 200, body: { client_id: "x" } }),
        }),
      "INVALID_REGISTRATION_URL",
    );
  });

  it("INVALID_REGISTRATION_URL on non-https", async () => {
    await expectDcrError(
      () =>
        registerClient({
          registrationEndpoint: "http://as.example/register",
          request: { redirect_uris: ["https://x/cb"] },
          fetch: async () => ({ status: 200, body: { client_id: "x" } }),
        }),
      "INVALID_REGISTRATION_URL",
    );
  });

  it("BLOCKED_URL on SSRF-blocked target", async () => {
    await expectDcrError(
      () =>
        registerClient({
          registrationEndpoint: "https://127.0.0.1/register",
          request: { redirect_uris: ["https://x/cb"] },
          fetch: async () => ({ status: 200, body: { client_id: "x" } }),
        }),
      "BLOCKED_URL",
    );
  });

  it("REGISTRATION_FAILED on 4xx/5xx", async () => {
    await expectDcrError(
      () =>
        registerClient({
          registrationEndpoint: "https://as.example/register",
          request: { redirect_uris: ["https://x/cb"] },
          fetch: async () => ({ status: 400, body: { error: "invalid_redirect_uri" } }),
        }),
      "REGISTRATION_FAILED",
    );
  });

  it("INVALID_RESPONSE on non-object body", async () => {
    await expectDcrError(
      () =>
        registerClient({
          registrationEndpoint: "https://as.example/register",
          request: { redirect_uris: ["https://x/cb"] },
          fetch: async () => ({ status: 200, body: null }),
        }),
      "INVALID_RESPONSE",
    );
  });

  it("MISSING_CLIENT_ID when response lacks client_id", async () => {
    await expectDcrError(
      () =>
        registerClient({
          registrationEndpoint: "https://as.example/register",
          request: { redirect_uris: ["https://x/cb"] },
          fetch: async () => ({ status: 201, body: { client_secret: "x" } }),
        }),
      "MISSING_CLIENT_ID",
    );
  });
});

async function expectDcrError(fn: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(DcrError);
  expect((caught as DcrError).code).toBe(code as never);
}
