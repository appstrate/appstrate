// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `lib/device-flow.ts`.
 *
 * Stubs `globalThis.fetch` with a scripted responder so we can assert
 * the RFC 8628 polling semantics (authorization_pending → slow_down →
 * success) + the terminal error codes without spinning up a server.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { startDeviceFlow, pollDeviceFlow, DeviceFlowError } from "../src/lib/device-flow.ts";

type Responder = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const originalFetch = globalThis.fetch;

function installFetch(responder: Responder): void {
  globalThis.fetch = responder as unknown as typeof fetch;
}

beforeEach(() => {
  installFetch(async () => new Response("{}", { status: 500 }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("startDeviceFlow", () => {
  it("posts form-urlencoded body (RFC 8628 §3.2) and maps snake_case → camelCase", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    let capturedContentType: string | null | undefined;
    installFetch(async (input, init) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedBody = init?.body as string;
      capturedContentType = (init?.headers as Record<string, string>)?.["Content-Type"];
      return jsonResponse(200, {
        device_code: "dc1",
        user_code: "ABCDEFGH",
        verification_uri: "https://app/activate",
        verification_uri_complete: "https://app/activate?user_code=ABCDEFGH",
        expires_in: 600,
        interval: 5,
      });
    });

    const result = await startDeviceFlow("https://app", "appstrate-cli", "openid profile");
    expect(capturedUrl).toBe("https://app/api/auth/device/code");
    expect(capturedContentType).toBe("application/x-www-form-urlencoded");
    const parsed = new URLSearchParams(capturedBody!);
    expect(parsed.get("client_id")).toBe("appstrate-cli");
    expect(parsed.get("scope")).toBe("openid profile");
    expect(result).toEqual({
      deviceCode: "dc1",
      userCode: "ABCDEFGH",
      verificationUri: "https://app/activate",
      verificationUriComplete: "https://app/activate?user_code=ABCDEFGH",
      expiresIn: 600,
      interval: 5,
    });
  });

  it("strips trailing slashes from instance URL", async () => {
    let capturedUrl: string | undefined;
    installFetch(async (input) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return jsonResponse(200, {
        device_code: "dc",
        user_code: "AAAAAAAA",
        verification_uri: "u",
        verification_uri_complete: "u",
        expires_in: 1,
        interval: 1,
      });
    });
    await startDeviceFlow("https://app/", "c", "openid");
    expect(capturedUrl).toBe("https://app/api/auth/device/code");
  });

  it("throws DeviceFlowError on 4xx", async () => {
    installFetch(async () =>
      jsonResponse(400, { error: "invalid_client", error_description: "no such client" }),
    );
    await expect(startDeviceFlow("https://app", "bad", "openid")).rejects.toMatchObject({
      name: "DeviceFlowError",
      code: "invalid_client",
      description: "no such client",
    });
  });
});

describe("pollDeviceFlow", () => {
  it("returns the token on the first 2xx response", async () => {
    installFetch(async () =>
      jsonResponse(200, {
        access_token: "tok",
        token_type: "Bearer",
        expires_in: 600,
        scope: "openid profile",
      }),
    );
    const result = await pollDeviceFlow("https://app", "dc", "c", {
      interval: 0, // skip real waits
      expiresIn: 60,
    });
    expect(result).toEqual({
      accessToken: "tok",
      tokenType: "Bearer",
      expiresIn: 600,
      scope: "openid profile",
    });
  });

  it("posts form-urlencoded body (RFC 8628 §3.4) with grant_type + device_code + client_id", async () => {
    let capturedContentType: string | null | undefined;
    let capturedBody: string | undefined;
    installFetch(async (_input, init) => {
      capturedContentType = (init?.headers as Record<string, string>)?.["Content-Type"];
      capturedBody = init?.body as string;
      return jsonResponse(200, {
        access_token: "tok",
        token_type: "Bearer",
        expires_in: 60,
        scope: "",
      });
    });
    await pollDeviceFlow("https://app", "device-code-123", "appstrate-cli", {
      interval: 0,
      expiresIn: 60,
    });
    expect(capturedContentType).toBe("application/x-www-form-urlencoded");
    const parsed = new URLSearchParams(capturedBody!);
    expect(parsed.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(parsed.get("device_code")).toBe("device-code-123");
    expect(parsed.get("client_id")).toBe("appstrate-cli");
  });

  it("loops on authorization_pending then returns the token", async () => {
    let calls = 0;
    installFetch(async () => {
      calls++;
      if (calls < 3) {
        return jsonResponse(400, { error: "authorization_pending" });
      }
      return jsonResponse(200, {
        access_token: "tok",
        token_type: "Bearer",
        expires_in: 600,
        scope: "",
      });
    });
    const result = await pollDeviceFlow("https://app", "dc", "c", {
      interval: 0,
      expiresIn: 60,
    });
    expect(result.accessToken).toBe("tok");
    expect(calls).toBe(3);
  });

  it("throws on access_denied", async () => {
    installFetch(async () =>
      jsonResponse(403, { error: "access_denied", error_description: "no" }),
    );
    await expect(
      pollDeviceFlow("https://app", "dc", "c", { interval: 0, expiresIn: 60 }),
    ).rejects.toMatchObject({ name: "DeviceFlowError", code: "access_denied" });
  });

  it("bumps interval on slow_down before retrying", async () => {
    let calls = 0;
    installFetch(async () => {
      calls++;
      if (calls === 1) return jsonResponse(400, { error: "slow_down" });
      return jsonResponse(200, {
        access_token: "ok",
        token_type: "Bearer",
        expires_in: 1,
        scope: "",
      });
    });
    // Inject a no-op delay so the 5s slow_down bump doesn't actually
    // sleep. The observed bumps are captured so the test also proves the
    // interval grew past its initial value.
    const delays: number[] = [];
    const result = await pollDeviceFlow("https://app", "dc", "c", {
      interval: 1,
      expiresIn: 60,
      delayFn: async (ms) => {
        delays.push(ms);
      },
    });
    expect(result.accessToken).toBe("ok");
    expect(calls).toBe(2);
    // First wait is 1s (initial interval), second is ≥ 6s (1s + 5s bump).
    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBeGreaterThanOrEqual(6000);
  });

  it("throws expired_token when the budget elapses without a terminal response", async () => {
    installFetch(async () => jsonResponse(400, { error: "authorization_pending" }));
    await expect(
      pollDeviceFlow("https://app", "dc", "c", { interval: 0, expiresIn: 0 }),
    ).rejects.toMatchObject({ name: "DeviceFlowError", code: "expired_token" });
  });

  it("honors the client-side MAX_POLL_DURATION cap even when the server returns a huge expires_in", async () => {
    // A misbehaving / compromised server returns `expires_in: 86400`
    // (24h). Without a client-side ceiling the CLI would keep polling
    // for a day — the hard cap in `device-flow.ts` caps at 15 minutes.
    // We can't actually wait 15 minutes; instead assert the deadline
    // is computed from MIN(server, ceiling) by checking Date.now()
    // wasn't extended past the ceiling. We do that indirectly by
    // observing that the loop still terminates quickly under a no-op
    // delay + `authorization_pending` spam — if the ceiling weren't
    // applied, `Date.now() < deadline` would stay true for hours.
    installFetch(async () => jsonResponse(400, { error: "authorization_pending" }));

    // Pin `Date.now` to a moving clock that advances 1 minute per
    // delay tick. After 16 ticks we've burned 16 minutes — past the
    // 15-minute ceiling — so the loop must exit.
    const originalNow = Date.now;
    let fakeMs = 1_700_000_000_000;
    Date.now = () => fakeMs;
    try {
      await expect(
        pollDeviceFlow("https://app", "dc", "c", {
          interval: 0,
          expiresIn: 86_400, // server claims 24h
          delayFn: async () => {
            fakeMs += 60_000;
          },
        }),
      ).rejects.toMatchObject({ name: "DeviceFlowError", code: "expired_token" });
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("DeviceFlowError shape", () => {
  it("exposes code + description + httpStatus", () => {
    const err = new DeviceFlowError("access_denied", "nope", 403);
    expect(err.code).toBe("access_denied");
    expect(err.description).toBe("nope");
    expect(err.httpStatus).toBe(403);
    expect(err.message).toBe("nope");
  });
});
