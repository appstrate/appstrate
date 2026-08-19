// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { registerDynamicClient, DynamicClientRegistrationError } from "../src/dcr.ts";

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("registerDynamicClient (RFC 7591)", () => {
  it("registers a public client and returns the client_id (no secret)", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      captured = { url, body: JSON.parse(String(init?.body)) };
      return jsonResponse({
        client_id: "mcp-client-abc",
        token_endpoint_auth_method: "none",
      });
    }) as unknown as typeof fetch;

    const reg = await registerDynamicClient({
      registrationEndpoint: "https://mcp.example.com/oauth/register",
      redirectUri: "https://app.test/api/integrations/callback",
      clientName: "Appstrate (app.test)",
      scopes: ["read", "write"],
      fetchImpl,
    });

    expect(reg.clientId).toBe("mcp-client-abc");
    expect(reg.clientSecret).toBeUndefined();
    expect(captured!.url).toBe("https://mcp.example.com/oauth/register");
    expect(captured!.body.redirect_uris).toEqual(["https://app.test/api/integrations/callback"]);
    expect(captured!.body.grant_types).toEqual(["authorization_code"]);
    expect(captured!.body.response_types).toEqual(["code"]);
    expect(captured!.body.token_endpoint_auth_method).toBe("none");
    expect(captured!.body.scope).toBe("read write");
  });

  it("registers for the refresh_token grant when requested", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({ client_id: "c-refresh" });
    }) as unknown as typeof fetch;

    await registerDynamicClient({
      registrationEndpoint: "https://as/register",
      redirectUri: "https://app/cb",
      clientName: "X",
      grantTypes: ["authorization_code", "refresh_token"],
      fetchImpl,
    });
    // Without the refresh_token grant in the registration, the AS never issues
    // a refresh token (Claude Code #7744) — assert it's threaded through.
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
  });

  it("defaults grant_types to authorization_code only when none requested", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({ client_id: "c-default" });
    }) as unknown as typeof fetch;

    await registerDynamicClient({
      registrationEndpoint: "https://as/register",
      redirectUri: "https://app/cb",
      clientName: "X",
      fetchImpl,
    });
    expect(body.grant_types).toEqual(["authorization_code"]);
  });

  it("defaults token_endpoint_auth_method to none and omits scope when empty", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({ client_id: "c1" });
    }) as unknown as typeof fetch;

    await registerDynamicClient({
      registrationEndpoint: "https://as/register",
      redirectUri: "https://app/cb",
      clientName: "X",
      fetchImpl,
    });
    expect(body.token_endpoint_auth_method).toBe("none");
    expect("scope" in body).toBe(false);
  });

  it("returns a confidential secret + RFC 7592 management credentials when issued", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        client_id: "c2",
        client_secret: "s3cr3t",
        registration_access_token: "rat-123",
        registration_client_uri: "https://as/register/c2",
      })) as unknown as typeof fetch;

    const reg = await registerDynamicClient({
      registrationEndpoint: "https://as/register",
      redirectUri: "https://app/cb",
      clientName: "X",
      tokenEndpointAuthMethod: "client_secret_post",
      fetchImpl,
    });
    expect(reg.clientSecret).toBe("s3cr3t");
    expect(reg.registrationAccessToken).toBe("rat-123");
    expect(reg.registrationClientUri).toBe("https://as/register/c2");
  });

  // RFC 7591 §3.2.1 lets the AS "replace any invalid values with suitable
  // default values" and state the substitution in the response. Discarding that
  // statement is how a `"none"` request came back registered as a confidential
  // client and was persisted as a public one — the contradiction then surfaced
  // at the OAuth callback, after the user had already consented.
  it("surfaces the token_endpoint_auth_method the AS registered, not the one requested", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({
        client_id: "c-substituted",
        client_secret: "s3cr3t",
        token_endpoint_auth_method: "client_secret_basic",
      });
    }) as unknown as typeof fetch;

    const reg = await registerDynamicClient({
      registrationEndpoint: "https://as/register",
      redirectUri: "https://app/cb",
      clientName: "X",
      tokenEndpointAuthMethod: "none",
      fetchImpl,
    });
    // Asked for a public client…
    expect(body.token_endpoint_auth_method).toBe("none");
    // …and the answer is reported as the AS gave it, so the caller can refuse.
    expect(reg.tokenEndpointAuthMethod).toBe("client_secret_basic");
    expect(reg.clientSecret).toBe("s3cr3t");
  });

  it("leaves tokenEndpointAuthMethod undefined when the AS omits it", async () => {
    // Absent is a distinct answer from `"none"`: the field is optional in the
    // response, so a caller must be able to tell "the AS said public" from "the
    // AS said nothing" rather than have the omission read as agreement.
    const fetchImpl = (async () =>
      jsonResponse({ client_id: "c-silent" })) as unknown as typeof fetch;
    const reg = await registerDynamicClient({
      registrationEndpoint: "https://as/register",
      redirectUri: "https://app/cb",
      clientName: "X",
      fetchImpl,
    });
    expect(reg.tokenEndpointAuthMethod).toBeUndefined();
    expect(reg.clientSecret).toBeUndefined();
  });

  it("throws on non-2xx with the status attached", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 403 })) as unknown as typeof fetch;
    await expect(
      registerDynamicClient({
        registrationEndpoint: "https://as/register",
        redirectUri: "https://app/cb",
        clientName: "X",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ name: "DynamicClientRegistrationError", status: 403 });
  });

  it("parses the OAuth error_description from a rejection body", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          error: "invalid_request",
          error_description: "Your integration is not currently allowlisted.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
    await expect(
      registerDynamicClient({
        registrationEndpoint: "https://as/register",
        redirectUri: "https://app/cb",
        clientName: "X",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "DynamicClientRegistrationError",
      status: 400,
      errorDescription: "Your integration is not currently allowlisted.",
    });
  });

  it("captures the RFC 6749 error code when the rejection carries no description", async () => {
    // `error_description` is OPTIONAL in RFC 6749 §5.2 / RFC 7591 §3.2.2, and a
    // code-only rejection is the common shape. Reading only the description
    // turned `{"error":"invalid_redirect_uri"}` — the one failure an operator
    // fixes in a minute — into a generic line plus a bare HTTP status.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "invalid_redirect_uri" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(
      registerDynamicClient({
        registrationEndpoint: "https://as/register",
        redirectUri: "https://app/cb",
        clientName: "X",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "DynamicClientRegistrationError",
      status: 400,
      errorCode: "invalid_redirect_uri",
      errorDescription: undefined,
    });
  });

  it("captures the error code alongside the description when both are present", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          error: "invalid_client_metadata",
          error_description: "redirect_uris must use https",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
    await expect(
      registerDynamicClient({
        registrationEndpoint: "https://as/register",
        redirectUri: "https://app/cb",
        clientName: "X",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      errorCode: "invalid_client_metadata",
      errorDescription: "redirect_uris must use https",
    });
  });

  it("leaves errorDescription undefined when the rejection body is not JSON", async () => {
    const fetchImpl = (async () =>
      new Response("plain text rejection", { status: 400 })) as unknown as typeof fetch;
    try {
      await registerDynamicClient({
        registrationEndpoint: "https://as/register",
        redirectUri: "https://app/cb",
        clientName: "X",
        fetchImpl,
      });
      throw new Error("expected registration to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(DynamicClientRegistrationError);
      const dcrErr = err as DynamicClientRegistrationError;
      expect(dcrErr.status).toBe(400);
      expect(dcrErr.errorDescription).toBeUndefined();
      expect(dcrErr.errorCode).toBeUndefined();
    }
  });

  it("throws when the response omits client_id", async () => {
    const fetchImpl = (async () => jsonResponse({ not_a_client: true })) as unknown as typeof fetch;
    await expect(
      registerDynamicClient({
        registrationEndpoint: "https://as/register",
        redirectUri: "https://app/cb",
        clientName: "X",
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(DynamicClientRegistrationError);
  });

  it("throws on a network failure", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      registerDynamicClient({
        registrationEndpoint: "https://as/register",
        redirectUri: "https://app/cb",
        clientName: "X",
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(DynamicClientRegistrationError);
  });
});
