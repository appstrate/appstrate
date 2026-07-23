// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `maybeTransformDeviceFlowFormBody` — the platform-level
 * shim that rewrites `application/x-www-form-urlencoded` bodies on
 * `/api/auth/device/code`, `/api/auth/cli/token`, and
 * `/api/auth/cli/revoke` into JSON before Better Auth's `better-call`
 * router (which only accepts JSON) sees the request. Belt-and-braces
 * coverage for the pure transform — the end-to-end wiring is covered by
 * the integration suite.
 */

import { describe, it, expect } from "bun:test";
import {
  maybeTransformDeviceFlowFormBody,
  withAuthorizationResponseIssuer,
} from "../../src/lib/auth-pipeline.ts";

function formRequest(url: string, body: Record<string, string>): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

describe("maybeTransformDeviceFlowFormBody", () => {
  it("rewrites form-urlencoded → JSON on /api/auth/device/code", async () => {
    const original = formRequest("http://host/api/auth/device/code", {
      client_id: "appstrate-cli",
      scope: "openid profile email",
    });
    const transformed = await maybeTransformDeviceFlowFormBody(original);
    expect(transformed.headers.get("content-type")).toBe("application/json");
    const body = (await transformed.json()) as Record<string, string>;
    expect(body).toEqual({
      client_id: "appstrate-cli",
      scope: "openid profile email",
    });
  });

  it("preserves JSON bodies untouched (tolerant server also accepts JSON)", async () => {
    const original = new Request("http://host/api/auth/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "appstrate-cli" }),
    });
    const transformed = await maybeTransformDeviceFlowFormBody(original);
    // Same instance — no rewrite needed.
    expect(transformed).toBe(original);
  });

  it("ignores non-device paths even with form-urlencoded", async () => {
    const original = formRequest("http://host/api/auth/sign-in/email", {
      email: "a@b.c",
      password: "x",
    });
    const transformed = await maybeTransformDeviceFlowFormBody(original);
    expect(transformed).toBe(original);
  });

  it("ignores non-POST methods on device paths", async () => {
    const original = new Request("http://host/api/auth/device/code", {
      method: "GET",
    });
    const transformed = await maybeTransformDeviceFlowFormBody(original);
    expect(transformed).toBe(original);
  });

  it("tolerates content-type with parameters (charset, boundary)", async () => {
    const original = new Request("http://host/api/auth/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams({ client_id: "cli" }).toString(),
    });
    const transformed = await maybeTransformDeviceFlowFormBody(original);
    expect(transformed.headers.get("content-type")).toBe("application/json");
    const body = (await transformed.json()) as Record<string, string>;
    expect(body.client_id).toBe("cli");
  });

  it("rewrites form-urlencoded → JSON on /api/auth/cli/token (issue #165)", async () => {
    const original = formRequest("http://host/api/auth/cli/token", {
      grant_type: "refresh_token",
      refresh_token: "rt_abc",
      client_id: "appstrate-cli",
    });
    const transformed = await maybeTransformDeviceFlowFormBody(original);
    expect(transformed.headers.get("content-type")).toBe("application/json");
    const body = (await transformed.json()) as Record<string, string>;
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe("rt_abc");
    expect(body.client_id).toBe("appstrate-cli");
  });

  it("rewrites form-urlencoded → JSON on /api/auth/cli/revoke (issue #165)", async () => {
    const original = formRequest("http://host/api/auth/cli/revoke", {
      token: "rt_abc",
      client_id: "appstrate-cli",
    });
    const transformed = await maybeTransformDeviceFlowFormBody(original);
    expect(transformed.headers.get("content-type")).toBe("application/json");
    const body = (await transformed.json()) as Record<string, string>;
    expect(body.token).toBe("rt_abc");
    expect(body.client_id).toBe("appstrate-cli");
  });

  it("is case-insensitive on the content-type match", async () => {
    const original = new Request("http://host/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "Application/X-WWW-Form-UrlEncoded" },
      body: new URLSearchParams({ client_id: "cli" }).toString(),
    });
    const transformed = await maybeTransformDeviceFlowFormBody(original);
    expect(transformed.headers.get("content-type")).toBe("application/json");
  });
});

describe("withAuthorizationResponseIssuer", () => {
  const issuer = "https://app.example.com/api/auth";

  it("adds iss to a redirect back to the registered OAuth client", () => {
    const request = new Request(
      "https://app.example.com/api/auth/oauth2/authorize?" +
        new URLSearchParams({
          redirect_uri: "http://127.0.0.1:63178/callback",
          state: "state-1",
        }),
    );
    const response = Response.redirect(
      "http://127.0.0.1:63178/callback?code=code-1&state=state-1",
      302,
    );

    const stamped = withAuthorizationResponseIssuer(request, response, issuer);

    const location = new URL(stamped.headers.get("location")!);
    expect(location.searchParams.get("iss")).toBe(issuer);
    expect(location.searchParams.get("code")).toBe("code-1");
    expect(location.searchParams.get("state")).toBe("state-1");
  });

  it("does not stamp internal login or consent redirects", () => {
    const request = new Request(
      "https://app.example.com/api/auth/oauth2/authorize?" +
        new URLSearchParams({
          redirect_uri: "http://127.0.0.1:63178/callback",
        }),
    );
    const response = Response.redirect("https://app.example.com/api/oauth/consent?sig=abc", 302);

    expect(withAuthorizationResponseIssuer(request, response, issuer)).toBe(response);
  });
});
