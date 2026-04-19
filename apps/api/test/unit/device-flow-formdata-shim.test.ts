// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `maybeTransformDeviceFlowFormBody` — the platform-level
 * shim that rewrites `application/x-www-form-urlencoded` bodies on
 * `/api/auth/device/code`, `/api/auth/device/token`, `/api/auth/cli/token`
 * and `/api/auth/cli/revoke` into JSON before Better Auth's `better-call`
 * router (which only accepts JSON) sees the request. Belt-and-braces
 * coverage for the pure transform — the end-to-end wiring is covered by
 * the integration suite.
 */

import { describe, it, expect } from "bun:test";
import { maybeTransformDeviceFlowFormBody } from "../../src/lib/auth-pipeline.ts";

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

  it("rewrites form-urlencoded → JSON on /api/auth/device/token", async () => {
    const original = formRequest("http://host/api/auth/device/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "dc_123",
      client_id: "appstrate-cli",
    });
    const transformed = await maybeTransformDeviceFlowFormBody(original);
    expect(transformed.headers.get("content-type")).toBe("application/json");
    const body = (await transformed.json()) as Record<string, string>;
    expect(body.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(body.device_code).toBe("dc_123");
    expect(body.client_id).toBe("appstrate-cli");
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
    const original = new Request("http://host/api/auth/device/token", {
      method: "POST",
      headers: { "Content-Type": "Application/X-WWW-Form-UrlEncoded" },
      body: new URLSearchParams({ client_id: "cli" }).toString(),
    });
    const transformed = await maybeTransformDeviceFlowFormBody(original);
    expect(transformed.headers.get("content-type")).toBe("application/json");
  });
});
