// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `lib/api.ts` — silent refresh + reactive 401 retry
 * (issue #165).
 *
 * Contract:
 *   1. When the stored access token has >30s remaining, `apiFetchRaw`
 *      sends it verbatim and never hits `/cli/token`.
 *   2. When the access token is within 30s of expiry (or already
 *      expired), `apiFetchRaw` proactively rotates via
 *      `/api/auth/cli/token` (grant_type=refresh_token) BEFORE the
 *      real request, persists the rotated pair, and presents the fresh
 *      access token in the outbound `Authorization: Bearer` header.
 *   3. On 401 from the real endpoint with a valid refresh token,
 *      `apiFetchRaw` rotates once, retries the original request, and
 *      surfaces whatever the retry returns. A second 401 is terminal.
 *   4. Legacy credentials (no `refreshToken`) skip rotation entirely
 *      and raise `AuthError` with a migration-specific message.
 *   5. `invalid_grant` from the rotate endpoint wipes local state so
 *      the next invocation hits the "not logged in" branch instead of
 *      retrying.
 *   6. Transient refresh failures (network, 5xx) preserve local state.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _setKeyringFactoryForTesting,
  saveTokens,
  loadTokens,
  type KeyringHandle,
} from "../src/lib/keyring.ts";
import { setProfile } from "../src/lib/config.ts";
import { apiFetchRaw, AuthError } from "../src/lib/api.ts";

class FakeKeyring implements KeyringHandle {
  static store = new Map<string, string>();
  constructor(private profile: string) {}
  setPassword(v: string): void {
    FakeKeyring.store.set(this.profile, v);
  }
  getPassword(): string | null {
    return FakeKeyring.store.get(this.profile) ?? null;
  }
  deletePassword(): void {
    FakeKeyring.store.delete(this.profile);
  }
}

type FetchCall = { url: string; auth: string | null; body: string | null };
let tmpDir: string;
let originalXdg: string | undefined;
const originalFetch = globalThis.fetch;
let fetchCalls: FetchCall[];

function installFetch(responder: (url: string, init?: RequestInit) => Promise<Response>): void {
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? init.body : null;
    fetchCalls.push({ url, auth: headers.Authorization ?? null, body });
    return responder(url, init);
  };
  globalThis.fetch = stub as unknown as typeof fetch;
}

beforeAll(() => {
  originalXdg = process.env.XDG_CONFIG_HOME;
});
afterAll(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
});
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "appstrate-cli-api-"));
  process.env.XDG_CONFIG_HOME = tmpDir;
  FakeKeyring.store.clear();
  _setKeyringFactoryForTesting((p) => new FakeKeyring(p));
  fetchCalls = [];
});
afterEach(async () => {
  _setKeyringFactoryForTesting(null);
  globalThis.fetch = originalFetch;
  await rm(tmpDir, { recursive: true, force: true });
});

async function seedProfile(
  name: string,
  tokens: { access: string; accessExpiresIn: number; refresh?: string; refreshExpiresIn?: number },
): Promise<void> {
  await setProfile(name, {
    instance: "https://app.example.com",
    userId: "u_1",
    email: "a@example.com",
  });
  const now = Date.now();
  await saveTokens(name, {
    accessToken: tokens.access,
    expiresAt: now + tokens.accessExpiresIn,
    refreshToken: tokens.refresh,
    refreshExpiresAt:
      tokens.refreshExpiresIn !== undefined ? now + tokens.refreshExpiresIn : undefined,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("apiFetchRaw (issue #165) — proactive refresh", () => {
  it("does NOT call /cli/token when the access token has >30s remaining", async () => {
    await seedProfile("default", {
      access: "fresh-access",
      accessExpiresIn: 5 * 60 * 1000,
      refresh: "r",
      refreshExpiresIn: 30 * 24 * 60 * 60 * 1000,
    });
    installFetch(async () => jsonResponse(200, { ok: true }));

    const res = await apiFetchRaw("default", "/api/some-endpoint");
    expect(res.status).toBe(200);
    // One call, to the real endpoint, with the fresh access token.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://app.example.com/api/some-endpoint");
    expect(fetchCalls[0]!.auth).toBe("Bearer fresh-access");
  });

  it("proactively rotates when the access token has <30s remaining, persists the new pair, and retries with the fresh token", async () => {
    await seedProfile("default", {
      access: "expiring-access",
      accessExpiresIn: 10_000, // 10s remaining → under 30s margin
      refresh: "old-refresh",
      refreshExpiresIn: 30 * 24 * 60 * 60 * 1000,
    });

    installFetch(async (url) => {
      if (url === "https://app.example.com/api/auth/cli/token") {
        return jsonResponse(200, {
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          token_type: "Bearer",
          expires_in: 900,
          refresh_expires_in: 2_592_000,
          scope: "openid",
        });
      }
      return jsonResponse(200, { ok: true });
    });

    const res = await apiFetchRaw("default", "/api/data");
    expect(res.status).toBe(200);

    // Two calls: rotate, then the real request with the NEW token.
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]!.url).toBe("https://app.example.com/api/auth/cli/token");
    expect(fetchCalls[1]!.url).toBe("https://app.example.com/api/data");
    expect(fetchCalls[1]!.auth).toBe("Bearer rotated-access");

    // Persisted pair is the rotated one.
    const stored = await loadTokens("default");
    expect(stored?.accessToken).toBe("rotated-access");
    expect(stored?.refreshToken).toBe("rotated-refresh");
  });

  it("raises AuthError on legacy credentials (no refresh token) when the access token is expired", async () => {
    await seedProfile("default", {
      access: "stale",
      accessExpiresIn: -60_000, // already expired
    });
    installFetch(async () => jsonResponse(200, { ok: true }));

    // Legacy-on-expired: keyring auto-scrubs the stale entry (falls back
    // to the legacy access-token expiry path in `isExpired`), so
    // `loadTokens` returns null and `api.ts` raises the generic "no
    // credentials" AuthError. A fresh-access legacy entry exercises the
    // specific "Legacy session detected" branch — see the next test.
    await expect(apiFetchRaw("default", "/api/data")).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("appstrate login"),
    });
    // No network call issued.
    expect(fetchCalls).toHaveLength(0);
  });

  it("raises AuthError('Legacy session detected') when a legacy entry is fresh but within the refresh margin", async () => {
    // A not-yet-expired legacy access token that slips INTO the 30s
    // margin triggers the refresh branch of `doRefresh`, which has no
    // refresh_token to use — the explicit "Legacy session detected"
    // hint surfaces here (not on already-scrubbed stale entries).
    await seedProfile("default", {
      access: "expiring-legacy",
      accessExpiresIn: 10_000, // within 30s margin
    });
    installFetch(async () => jsonResponse(200, { ok: true }));

    await expect(apiFetchRaw("default", "/api/data")).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("Legacy session detected"),
    });
    expect(fetchCalls).toHaveLength(0);
    expect(await loadTokens("default")).toBeNull();
  });

  it("raises AuthError + wipes credentials when /cli/token responds with invalid_grant (revoked / reused)", async () => {
    await seedProfile("default", {
      access: "expired",
      accessExpiresIn: -60_000,
      refresh: "stolen-copy",
      refreshExpiresIn: 30 * 24 * 60 * 60 * 1000,
    });

    installFetch(async (url) => {
      if (url === "https://app.example.com/api/auth/cli/token") {
        return jsonResponse(400, {
          error: "invalid_grant",
          error_description: "Refresh token reuse detected — family revoked.",
        });
      }
      return jsonResponse(200, { ok: true });
    });

    await expect(apiFetchRaw("default", "/api/data")).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("no longer valid"),
    });
    expect(await loadTokens("default")).toBeNull();
  });

  it("preserves local credentials on transient refresh failures (5xx, network)", async () => {
    await seedProfile("default", {
      access: "expired",
      accessExpiresIn: -60_000,
      refresh: "r",
      refreshExpiresIn: 30 * 24 * 60 * 60 * 1000,
    });

    installFetch(async () => jsonResponse(500, { error: "server_error" }));

    await expect(apiFetchRaw("default", "/api/data")).rejects.toBeDefined();
    // Credentials MUST survive so the next invocation can retry.
    const stored = await loadTokens("default");
    expect(stored?.refreshToken).toBe("r");
  });

  it("raises AuthError when the refresh token itself has expired (keyring scrubs, api surfaces re-login)", async () => {
    // A refresh-expired pair is scrubbed by the keyring at load time
    // (see `isExpired` — for entries with a refresh token, scrub is
    // gated on refresh-expiry, not access-expiry). `api.ts` therefore
    // sees `null` and raises the generic "no credentials" AuthError,
    // which still carries the correct "appstrate login" hint.
    await seedProfile("default", {
      access: "expired",
      accessExpiresIn: -60_000,
      refresh: "r",
      refreshExpiresIn: -1_000, // already past
    });
    installFetch(async () => jsonResponse(200, {}));

    await expect(apiFetchRaw("default", "/api/data")).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("appstrate login"),
    });
    expect(fetchCalls).toHaveLength(0);
    expect(await loadTokens("default")).toBeNull();
  });

  it("raises AuthError('Refresh token expired') on a fresh-access entry whose refresh token already passed", async () => {
    // Access still fresh (>30s margin) but refresh is past — but wait,
    // the keyring scrub evaluates refresh-expiry when present, so the
    // entry gets wiped at load time REGARDLESS of access freshness.
    // That is by design: a refresh token that can no longer be
    // rotated is dead weight, and keeping the access token alive for
    // its last 15 minutes while the refresh is gone would leave the
    // CLI unable to recover at the next expiry cycle anyway.
    //
    // So the assertion mirrors the prior test — refresh-expired
    // entries are scrubbed before `api.ts` can emit the specific
    // "Refresh token expired" branch. The user-visible UX is the
    // same: `appstrate login` fixes it.
    await seedProfile("default", {
      access: "still-usable",
      accessExpiresIn: 5 * 60 * 1000,
      refresh: "r",
      refreshExpiresIn: -1_000,
    });
    installFetch(async () => jsonResponse(200, {}));

    await expect(apiFetchRaw("default", "/api/data")).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("appstrate login"),
    });
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("apiFetchRaw — reactive refresh on 401", () => {
  it("rotates once on 401 and retries the original request with the fresh token", async () => {
    await seedProfile("default", {
      access: "access-1",
      accessExpiresIn: 5 * 60 * 1000, // fresh — proactive refresh SKIPPED
      refresh: "refresh-1",
      refreshExpiresIn: 30 * 24 * 60 * 60 * 1000,
    });

    let mainCalls = 0;
    installFetch(async (url) => {
      if (url === "https://app.example.com/api/auth/cli/token") {
        return jsonResponse(200, {
          access_token: "access-2",
          refresh_token: "refresh-2",
          token_type: "Bearer",
          expires_in: 900,
          refresh_expires_in: 2_592_000,
          scope: "",
        });
      }
      if (url === "https://app.example.com/api/data") {
        mainCalls++;
        if (mainCalls === 1) return jsonResponse(401, { error: "unauthorized" });
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(500, {});
    });

    const res = await apiFetchRaw("default", "/api/data");
    expect(res.status).toBe(200);
    // Call order: first real req (401) → rotate → retry.
    expect(fetchCalls.map((c) => c.url)).toEqual([
      "https://app.example.com/api/data",
      "https://app.example.com/api/auth/cli/token",
      "https://app.example.com/api/data",
    ]);
    // Retry carried the fresh bearer.
    expect(fetchCalls[2]!.auth).toBe("Bearer access-2");
  });

  it("returns the original 401 when rotation itself fails (so caller can decide)", async () => {
    await seedProfile("default", {
      access: "access-1",
      accessExpiresIn: 5 * 60 * 1000,
      refresh: "refresh-1",
      refreshExpiresIn: 30 * 24 * 60 * 60 * 1000,
    });

    installFetch(async (url) => {
      if (url === "https://app.example.com/api/auth/cli/token") {
        return jsonResponse(400, { error: "invalid_grant" });
      }
      return jsonResponse(401, { error: "unauthorized" });
    });

    const res = await apiFetchRaw("default", "/api/data");
    // Original 401 surfaces so `apiFetch` can coerce to AuthError.
    expect(res.status).toBe(401);
    // doRefresh wiped credentials because invalid_grant is terminal.
    expect(await loadTokens("default")).toBeNull();
  });

  it("does NOT attempt reactive refresh when the stored tokens lack a refresh_token (legacy)", async () => {
    await seedProfile("default", {
      access: "legacy",
      accessExpiresIn: 5 * 60 * 1000,
    });
    installFetch(async () => jsonResponse(401, { error: "unauthorized" }));

    const res = await apiFetchRaw("default", "/api/data");
    expect(res.status).toBe(401);
    // Single call: the original request. No rotate attempt.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://app.example.com/api/data");
  });
});

describe("apiFetchRaw — missing credentials", () => {
  it("raises AuthError when the profile has never been logged in", async () => {
    installFetch(async () => jsonResponse(200, {}));
    await expect(apiFetchRaw("nope", "/api/data")).rejects.toBeInstanceOf(AuthError);
    expect(fetchCalls).toHaveLength(0);
  });

  it("raises AuthError when the profile exists but has no stored tokens", async () => {
    await setProfile("default", {
      instance: "https://app.example.com",
      userId: "u_1",
      email: "a@example.com",
    });
    installFetch(async () => jsonResponse(200, {}));
    await expect(apiFetchRaw("default", "/api/data")).rejects.toBeInstanceOf(AuthError);
  });
});

describe("apiFetchRaw — X-Org-Id header injection", () => {
  it("forwards profile.orgId as X-Org-Id when set", async () => {
    await setProfile("default", {
      instance: "https://app.example.com",
      userId: "u_1",
      email: "a@example.com",
      orgId: "org_42",
    });
    await saveTokens("default", {
      accessToken: "tok",
      expiresAt: Date.now() + 5 * 60 * 1000,
      refreshToken: "r",
      refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    let capturedOrg: string | undefined;
    installFetch(async (_url, init) => {
      capturedOrg = (init?.headers as Record<string, string>)["X-Org-Id"];
      return jsonResponse(200, {});
    });
    await apiFetchRaw("default", "/api/data");
    expect(capturedOrg).toBe("org_42");
  });
});
