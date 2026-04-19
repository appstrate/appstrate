// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `lib/device-flow.ts`.
 *
 * Stubs `globalThis.fetch` with a scripted responder so we can assert
 * the RFC 8628 polling semantics (authorization_pending → slow_down →
 * success) + the terminal error codes without spinning up a server.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  startDeviceFlow,
  pollDeviceFlow,
  refreshCliTokens,
  revokeCliRefreshToken,
  DeviceFlowError,
} from "../src/lib/device-flow.ts";

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
        verification_uri: "https://app/activate",
        verification_uri_complete: "https://app/activate?user_code=AAAAAAAA",
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

  describe("verification URL safety", () => {
    // A malicious or compromised server MUST NOT be able to trick the
    // CLI into passing an arbitrary scheme / host to `open()` /
    // `xdg-open` — on Linux, that dispatches to registered handlers
    // for `.desktop`, custom schemes, etc. (MITRE T1547.013).
    const ATTACK_URLS = [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "customscheme://evil",
      "data:text/html,<script>",
      "ftp://app/activate",
    ];

    for (const attack of ATTACK_URLS) {
      it(`rejects verification_uri_complete with unsafe scheme: ${attack}`, async () => {
        installFetch(async () =>
          jsonResponse(200, {
            device_code: "dc",
            user_code: "AAAAAAAA",
            verification_uri: "https://app/activate",
            verification_uri_complete: attack,
            expires_in: 600,
            interval: 5,
          }),
        );
        await expect(startDeviceFlow("https://app", "c", "openid")).rejects.toMatchObject({
          name: "DeviceFlowError",
          code: "invalid_request",
        });
      });
    }

    it("rejects verification URL whose host != instance host", async () => {
      // DNS-rebinding / attacker-controlled redirect: the server
      // returns a plausible-looking but off-origin URL. The CLI must
      // refuse before the user's browser is opened.
      installFetch(async () =>
        jsonResponse(200, {
          device_code: "dc",
          user_code: "AAAAAAAA",
          verification_uri: "https://evil.example.com/activate",
          verification_uri_complete: "https://evil.example.com/activate?user_code=AAAAAAAA",
          expires_in: 600,
          interval: 5,
        }),
      );
      await expect(startDeviceFlow("https://app", "c", "openid")).rejects.toMatchObject({
        name: "DeviceFlowError",
        code: "invalid_request",
      });
    });

    it("rejects unparseable verification URL", async () => {
      installFetch(async () =>
        jsonResponse(200, {
          device_code: "dc",
          user_code: "AAAAAAAA",
          verification_uri: "https://app/activate",
          verification_uri_complete: "not a url",
          expires_in: 600,
          interval: 5,
        }),
      );
      await expect(startDeviceFlow("https://app", "c", "openid")).rejects.toMatchObject({
        name: "DeviceFlowError",
        code: "invalid_request",
      });
    });

    it("rejects verification URL on a different port (same host)", async () => {
      // Same-origin is scheme + host + PORT (RFC 6454). A compromised
      // server on `app.example.com:443` pointing the approval flow at
      // `app.example.com:8443` (an attacker-controlled listener on the
      // same host) must be refused.
      installFetch(async () =>
        jsonResponse(200, {
          device_code: "dc",
          user_code: "AAAAAAAA",
          verification_uri: "https://app.example.com:8443/activate",
          verification_uri_complete: "https://app.example.com:8443/activate?user_code=AAAAAAAA",
          expires_in: 600,
          interval: 5,
        }),
      );
      await expect(startDeviceFlow("https://app.example.com", "c", "openid")).rejects.toMatchObject(
        {
          name: "DeviceFlowError",
          code: "invalid_request",
        },
      );
    });

    it("tolerates a single trailing dot on the verification URL host", async () => {
      // `https://app.example.com.` and `https://app.example.com` are
      // the same FQDN (the trailing dot is DNS-canonical). Refusing
      // would produce spurious UX breakage if the server happens to
      // emit the dotted form.
      installFetch(async () =>
        jsonResponse(200, {
          device_code: "dc",
          user_code: "AAAAAAAA",
          verification_uri: "https://app.example.com./activate",
          verification_uri_complete: "https://app.example.com./activate?user_code=AAAAAAAA",
          expires_in: 600,
          interval: 5,
        }),
      );
      // Must succeed (not throw).
      const result = await startDeviceFlow("https://app.example.com", "c", "openid");
      expect(result.userCode).toBe("AAAAAAAA");
    });

    it("treats :80 / :443 as equivalent to the default port", async () => {
      // `http://app:80` and `http://app` canonicalize to the same
      // origin — the explicit-port form must not be refused.
      installFetch(async () =>
        jsonResponse(200, {
          device_code: "dc",
          user_code: "AAAAAAAA",
          verification_uri: "https://app.example.com:443/activate",
          verification_uri_complete: "https://app.example.com:443/activate?user_code=AAAAAAAA",
          expires_in: 600,
          interval: 5,
        }),
      );
      const result = await startDeviceFlow("https://app.example.com", "c", "openid");
      expect(result.userCode).toBe("AAAAAAAA");
    });
  });
});

describe("pollDeviceFlow", () => {
  it("returns the token on the first 2xx response", async () => {
    let capturedUrl: string | undefined;
    installFetch(async (input) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return jsonResponse(200, {
        access_token: "tok",
        refresh_token: "rt",
        token_type: "Bearer",
        expires_in: 600,
        refresh_expires_in: 2_592_000,
        scope: "openid profile",
      });
    });
    const result = await pollDeviceFlow("https://app", "dc", "c", {
      interval: 0, // skip real waits
      expiresIn: 60,
    });
    // Issue #165: polling hits the new `/cli/token` endpoint, not the
    // legacy `/device/token`. The response shape widens with
    // refresh_token + refresh_expires_in — both surface on the parsed
    // return value.
    expect(capturedUrl).toBe("https://app/api/auth/cli/token");
    expect(result).toEqual({
      accessToken: "tok",
      refreshToken: "rt",
      tokenType: "Bearer",
      expiresIn: 600,
      refreshExpiresIn: 2_592_000,
      scope: "openid profile",
    });
  });

  it("surfaces missing refresh_token as undefined (server downgrade signal)", async () => {
    // A pre-2.x platform would keep the old `/device/token` response
    // shape without a refresh_token. The CLI `commands/login.ts`
    // refuses to persist such a response — here we verify the parser
    // faithfully reports `undefined` so that higher-level code can act
    // on it, rather than silently coerce to an empty string.
    installFetch(async () =>
      jsonResponse(200, {
        access_token: "tok",
        token_type: "Bearer",
        expires_in: 600,
        scope: "",
      }),
    );
    const result = await pollDeviceFlow("https://app", "dc", "c", {
      interval: 0,
      expiresIn: 60,
    });
    expect(result.accessToken).toBe("tok");
    expect(result.refreshToken).toBeUndefined();
    expect(result.refreshExpiresIn).toBeUndefined();
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
        refresh_token: "rt",
        token_type: "Bearer",
        expires_in: 600,
        refresh_expires_in: 2_592_000,
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
        refresh_token: "rt",
        token_type: "Bearer",
        expires_in: 1,
        refresh_expires_in: 2_592_000,
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
    // We can't actually wait 15 minutes; instead inject a fake clock
    // (scoped to this call via `opts.now`) that advances 1 minute per
    // delay tick. After 16 ticks we've burned 16 minutes — past the
    // 15-minute ceiling — so the loop must exit. Scoped injection
    // avoids the old global `Date.now` monkey-patch, which would leak
    // into any parallel test in the same Bun worker.
    installFetch(async () => jsonResponse(400, { error: "authorization_pending" }));

    let fakeMs = 1_700_000_000_000;
    await expect(
      pollDeviceFlow("https://app", "dc", "c", {
        interval: 0,
        expiresIn: 86_400, // server claims 24h
        delayFn: async () => {
          fakeMs += 60_000;
        },
        now: () => fakeMs,
      }),
    ).rejects.toMatchObject({ name: "DeviceFlowError", code: "expired_token" });
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

// ─── Issue #165: refreshCliTokens / revokeCliRefreshToken ───────────────────
//
// Added by issue #165. Cover the grant_type=refresh_token and the
// revocation endpoint paths the CLI exercises during silent rotation and
// logout.

describe("refreshCliTokens", () => {
  it("posts grant_type=refresh_token to /api/auth/cli/token and returns a rotated pair", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    let capturedContentType: string | null | undefined;
    installFetch(async (input, init) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedBody = init?.body as string;
      capturedContentType = (init?.headers as Record<string, string>)?.["Content-Type"];
      return jsonResponse(200, {
        access_token: "new-access",
        refresh_token: "new-refresh",
        token_type: "Bearer",
        expires_in: 900,
        refresh_expires_in: 2_592_000,
        scope: "openid",
      });
    });
    const result = await refreshCliTokens("https://app", "appstrate-cli", "old-refresh");
    expect(capturedUrl).toBe("https://app/api/auth/cli/token");
    expect(capturedContentType).toBe("application/x-www-form-urlencoded");
    const parsed = new URLSearchParams(capturedBody!);
    expect(parsed.get("grant_type")).toBe("refresh_token");
    expect(parsed.get("refresh_token")).toBe("old-refresh");
    expect(parsed.get("client_id")).toBe("appstrate-cli");
    expect(result).toEqual({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      tokenType: "Bearer",
      expiresIn: 900,
      refreshExpiresIn: 2_592_000,
      scope: "openid",
    });
  });

  it("throws DeviceFlowError(invalid_grant) when the server rejects the refresh token (reuse / revoked / expired)", async () => {
    installFetch(async () =>
      jsonResponse(400, {
        error: "invalid_grant",
        error_description: "Refresh token reuse detected — family revoked.",
      }),
    );
    await expect(
      refreshCliTokens("https://app", "appstrate-cli", "stale-refresh"),
    ).rejects.toMatchObject({
      name: "DeviceFlowError",
      code: "invalid_grant",
    });
  });

  it("defaults scope to empty string when the server omits it", async () => {
    installFetch(async () =>
      jsonResponse(200, {
        access_token: "a",
        refresh_token: "r",
        token_type: "Bearer",
        expires_in: 900,
        refresh_expires_in: 2_592_000,
      }),
    );
    const result = await refreshCliTokens("https://app", "c", "x");
    expect(result.scope).toBe("");
  });
});

describe("revokeCliRefreshToken", () => {
  it("posts the refresh token + client_id to /api/auth/cli/revoke", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    installFetch(async (input, init) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedBody = init?.body as string;
      return jsonResponse(200, { revoked: true });
    });
    await revokeCliRefreshToken("https://app", "appstrate-cli", "some-refresh");
    expect(capturedUrl).toBe("https://app/api/auth/cli/revoke");
    const parsed = new URLSearchParams(capturedBody!);
    expect(parsed.get("token")).toBe("some-refresh");
    expect(parsed.get("client_id")).toBe("appstrate-cli");
  });

  it("throws DeviceFlowError on non-2xx responses so logout can warn the user", async () => {
    installFetch(async () =>
      jsonResponse(401, {
        error: "invalid_client",
        error_description: "Unknown client",
      }),
    );
    await expect(revokeCliRefreshToken("https://app", "unknown-client", "r")).rejects.toMatchObject(
      {
        name: "DeviceFlowError",
        code: "invalid_client",
      },
    );
  });

  it("returns silently on 200 OK regardless of the `revoked` field value", async () => {
    // An idempotent second logout hits `{ revoked: false }` — the
    // client-side wipe still proceeds, so the function must not throw.
    installFetch(async () => jsonResponse(200, { revoked: false }));
    await revokeCliRefreshToken("https://app", "c", "r"); // no throw
  });

  it("tolerates a malformed JSON body on success (revocation is fire-and-forget)", async () => {
    installFetch(
      async () =>
        new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );
    // Must not throw: a server returning an empty / text body on 200
    // is out-of-spec but the CLI does not rely on the body for
    // correctness (local wipe is authoritative).
    await revokeCliRefreshToken("https://app", "c", "r");
  });
});
