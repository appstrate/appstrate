// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `lib/api.ts` — silent refresh + reactive 401 retry.
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
 *   4. `invalid_grant` from the rotate endpoint wipes local state so
 *      the next invocation hits the "not logged in" branch instead of
 *      retrying.
 *   5. Transient refresh failures (network, 5xx) preserve local state.
 *   6. A refresh re-reads the stored pair under the cross-process
 *      credentials lock: a pair another process rotated (or a login
 *      replaced) meanwhile is used as is, never redeemed again, and a pair
 *      a logout deleted stays deleted. The multi-process proof is
 *      `token-refresh-lock.test.ts`.
 *   7. Failures that leave the credentials intact (busy lock, request
 *      timeout) surface as themselves, never as a re-login 401.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  deleteTokens,
  saveTokens,
  loadTokens,
  _setKeyringFactoryForTesting,
  type Tokens,
} from "../src/lib/keyring.ts";
import { FileLockBusyError } from "../src/lib/file-lock.ts";
// Imported directly for the one test that needs a profile with NO stored
// tokens — the shared seed always writes a pair.
import { getConfigDir, setProfile } from "../src/lib/config.ts";
import {
  apiFetchRaw,
  explicitApiKey,
  resolveApiKeyTarget,
  AuthError,
  withCredentialsLock,
  _inFlightRefreshSizeForTesting,
} from "../src/lib/api.ts";
import {
  installFakeKeyring,
  seedLoggedInProfile,
  useTempConfigHome,
  type FakeKeyringInstall,
} from "./helpers/auth-fixture.ts";
import { holdCredentialsLock, jumpClock } from "./helpers/credentials-lock.ts";

type FetchCall = { url: string; auth: string | null; body: string | null };
const configHome = useTempConfigHome("appstrate-cli-api-");
let keyring: FakeKeyringInstall;
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

beforeEach(async () => {
  await configHome.setup();
  keyring = installFakeKeyring();
  fetchCalls = [];
});
afterEach(async () => {
  keyring.restore();
  globalThis.fetch = originalFetch;
  await configHome.teardown();
});

/** TTLs here are relative offsets — every test in this file is about expiry. */
async function seedProfile(
  name: string,
  tokens: { access: string; accessExpiresIn: number; refresh?: string; refreshExpiresIn?: number },
): Promise<void> {
  const now = Date.now();
  await seedLoggedInProfile(name, {
    tokens: {
      accessToken: tokens.access,
      expiresAt: now + tokens.accessExpiresIn,
      refreshToken: tokens.refresh ?? "rt-default",
      refreshExpiresAt:
        tokens.refreshExpiresIn !== undefined
          ? now + tokens.refreshExpiresIn
          : now + 30 * 24 * 60 * 60 * 1000,
    },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function peerRotatedTokens(): Tokens {
  return {
    accessToken: "peer-access",
    expiresAt: Date.now() + 15 * 60 * 1000,
    refreshToken: "peer-refresh",
    refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  };
}

/**
 * Another process changes the stored pair right after this process's `nth`
 * read of it: the window between reading the pair and taking the credentials
 * lock.
 */
function changeAfterRead(nth: number, change: () => void): void {
  let reads = 0;
  _setKeyringFactoryForTesting((profile) => ({
    setPassword(value: string): void {
      keyring.store.set(profile, value);
    },
    getPassword(): string | null {
      const value = keyring.store.get(profile) ?? null;
      if (++reads === nth) change();
      return value;
    },
    deletePassword(): void {
      keyring.store.delete(profile);
    },
  }));
}

function peerRotates(): void {
  keyring.store.set("default", JSON.stringify(peerRotatedTokens()));
}

function peerLogsOut(): void {
  keyring.store.delete("default");
}

function settle(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => undefined,
    (e: unknown) => e,
  );
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

  it("raises AuthError when the refresh token itself has expired (read as absent, api surfaces re-login)", async () => {
    // The keyring reads a refresh-expired pair as absent (`isExpired` is
    // gated on refresh-expiry, not access-expiry), so `api.ts` raises the
    // generic "no credentials" AuthError, which still names the login.
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

  it("raises the no-credentials AuthError on a fresh-access entry whose refresh token already passed", async () => {
    // Access still fresh (>30s margin) but refresh is past: the keyring
    // reads the pair as absent REGARDLESS of access freshness. By design:
    // a refresh token that can no longer be rotated is dead weight, and
    // keeping the access token for its last minutes would only defer the
    // same re-login to the next expiry. So the assertion mirrors the prior
    // test: `appstrate login` fixes it.
    await seedProfile("default", {
      access: "still-usable",
      accessExpiresIn: 5 * 60 * 1000,
      refresh: "r",
      refreshExpiresIn: -1_000,
    });
    installFetch(async () => jsonResponse(200, {}));

    await expect(apiFetchRaw("default", "/api/data")).rejects.toMatchObject({
      name: "AuthError",
      message:
        'No credentials for profile "default". Run: appstrate login --profile default --instance https://app.example.com',
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
    expect((await loadTokens("default"))?.refreshToken).toBe("refresh-2");
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
    await seedLoggedInProfile("default", {
      orgId: "org_42",
      tokens: { accessToken: "tok", expiresAt: Date.now() + 5 * 60 * 1000, refreshToken: "r" },
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

describe("apiFetchRaw — X-Space-Id header injection", () => {
  it("forwards profile.spaceId as X-Space-Id when set", async () => {
    await seedLoggedInProfile("default", {
      orgId: "org_42",
      spaceId: "spc_7",
      tokens: { accessToken: "tok", expiresAt: Date.now() + 5 * 60 * 1000, refreshToken: "r" },
    });
    let capturedSpace: string | undefined;
    let capturedOrg: string | undefined;
    installFetch(async (_url, init) => {
      const h = init?.headers as Record<string, string>;
      capturedSpace = h["X-Space-Id"];
      capturedOrg = h["X-Org-Id"];
      return jsonResponse(200, {});
    });
    await apiFetchRaw("default", "/api/data");
    // Both headers sent when both are pinned — the common agent recipe path.
    expect(capturedSpace).toBe("spc_7");
    expect(capturedOrg).toBe("org_42");
  });

  it("does NOT send X-Space-Id when profile.spaceId is unset", async () => {
    await seedLoggedInProfile("default", {
      orgId: "org_42",
      tokens: { accessToken: "tok", expiresAt: Date.now() + 5 * 60 * 1000, refreshToken: "r" },
    });
    let sawSpaceHeader = true;
    installFetch(async (_url, init) => {
      const h = init?.headers as Record<string, string>;
      sawSpaceHeader = "X-Space-Id" in h;
      return jsonResponse(200, {});
    });
    await apiFetchRaw("default", "/api/data");
    expect(sawSpaceHeader).toBe(false);
  });
});

describe("apiFetchRaw — concurrent refresh dedup (PR #191 review)", () => {
  it("collapses N parallel proactive refreshes into ONE /cli/token call", async () => {
    // Seed with an access token that is past the 30s proactive-refresh
    // margin so every parallel call triggers the rotate branch.
    await seedProfile("default", {
      access: "expiring-access",
      accessExpiresIn: 5_000, // under 30s margin → all N callers need refresh
      refresh: "r1",
      refreshExpiresIn: 30 * 24 * 60 * 60 * 1000,
    });

    let rotateCalls = 0;
    const gate = Promise.withResolvers<void>();
    installFetch(async (url) => {
      if (url.endsWith("/api/auth/cli/token")) {
        rotateCalls += 1;
        // Hold the response until we fire all parallel requests so the
        // dedup window is maximally open.
        await gate.promise;
        return jsonResponse(200, {
          access_token: "rotated",
          refresh_token: "r2",
          token_type: "Bearer",
          expires_in: 900,
          refresh_expires_in: 2592000,
          scope: "openid",
        });
      }
      return jsonResponse(200, { ok: true });
    });

    const calls = [
      apiFetchRaw("default", "/api/a"),
      apiFetchRaw("default", "/api/b"),
      apiFetchRaw("default", "/api/c"),
    ];
    // Tiny yield so all three enter resolveAccessToken and share the in-flight refresh.
    await Promise.resolve();
    gate.resolve();
    const results = await Promise.all(calls);
    for (const r of results) expect(r.status).toBe(200);
    // Three real-endpoint calls + exactly one refresh.
    expect(rotateCalls).toBe(1);
    // Mutex map drained after completion.
    expect(_inFlightRefreshSizeForTesting()).toBe(0);
  });

  it("does not fire a second refresh when a parallel caller already rotated during our 401", async () => {
    // Start with an access token that is OUT of the proactive margin
    // (so no proactive refresh) but that the server will reject with
    // 401, forcing the reactive branch. Meanwhile simulate another
    // caller having already refreshed: we manually flip the stored
    // token to a "newer" access before the 401 handler reads it.
    await seedProfile("default", {
      access: "stale-but-fresh-enough",
      accessExpiresIn: 5 * 60 * 1000,
      refresh: "r1",
      refreshExpiresIn: 30 * 24 * 60 * 60 * 1000,
    });

    let rotateCalls = 0;
    installFetch(async (url, init) => {
      if (url.endsWith("/api/auth/cli/token")) {
        rotateCalls += 1;
        return jsonResponse(200, {
          access_token: "shouldnt-be-needed",
          refresh_token: "r2",
          token_type: "Bearer",
          expires_in: 900,
          refresh_expires_in: 2592000,
          scope: "openid",
        });
      }
      const auth = (init?.headers as Record<string, string>).Authorization ?? "";
      if (auth.includes("stale-but-fresh-enough")) {
        // Simulate the competing caller's successful rotation landing
        // between our first fetch and our stored-token re-read.
        await saveTokens("default", {
          accessToken: "peer-rotated",
          expiresAt: Date.now() + 15 * 60 * 1000,
          refreshToken: "r-peer",
          refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
        });
        return jsonResponse(401, { error: "invalid_token" });
      }
      if (auth.includes("peer-rotated")) {
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(500, {});
    });

    const res = await apiFetchRaw("default", "/api/x");
    expect(res.status).toBe(200);
    // We should have retried with the peer's rotated token WITHOUT
    // spending a second rotate call of our own.
    expect(rotateCalls).toBe(0);
  });
});

describe("apiFetchRaw — another writer landed first (issue #1806)", () => {
  // The token endpoint answers what the server does to a second redemption of
  // a refresh token: reuse detected, family revoked.
  const reuseDetected = (): Response => jsonResponse(400, { error: "invalid_grant" });

  // A login landing in that window looks the same: a pair with another
  // refresh token, which the refresh adopts.
  it("proactive: uses the peer's access token instead of redeeming the stale refresh token", async () => {
    await seedProfile("default", {
      access: "expired",
      accessExpiresIn: -60_000,
      refresh: "stale-refresh",
    });
    changeAfterRead(1, peerRotates);
    installFetch(async (url) =>
      url.endsWith("/api/auth/cli/token") ? reuseDetected() : jsonResponse(200, { ok: true }),
    );

    const res = await apiFetchRaw("default", "/api/data");
    expect(res.status).toBe(200);
    expect(fetchCalls.map((c) => c.url)).toEqual(["https://app.example.com/api/data"]);
    expect(fetchCalls[0]!.auth).toBe("Bearer peer-access");
    expect((await loadTokens("default"))?.refreshToken).toBe("peer-refresh");
  });

  it("reactive 401: uses the peer's access token instead of redeeming the stale refresh token", async () => {
    await seedProfile("default", {
      access: "access-1",
      accessExpiresIn: 5 * 60 * 1000, // fresh — the refresh comes from the 401
      refresh: "refresh-1",
    });
    // Read 1 resolves the bearer, read 2 is the 401 branch's own; the peer
    // lands after that one, so only the read under the lock can see it.
    changeAfterRead(2, peerRotates);
    installFetch(async (url, init) => {
      if (url.endsWith("/api/auth/cli/token")) return reuseDetected();
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === "Bearer peer-access"
        ? jsonResponse(200, { ok: true })
        : jsonResponse(401, { error: "invalid_token" });
    });

    const res = await apiFetchRaw("default", "/api/data");
    expect(res.status).toBe(200);
    // The rejected request, then its retry: no call to the token endpoint.
    expect(fetchCalls.map((c) => c.auth)).toEqual(["Bearer access-1", "Bearer peer-access"]);
    expect((await loadTokens("default"))?.refreshToken).toBe("peer-refresh");
  });

  it("a login to another instance, landing between read and lock, is refused rather than adopted", async () => {
    await seedProfile("default", {
      access: "expired",
      accessExpiresIn: -60_000,
      refresh: "stale-refresh",
    });
    // Login's own order, under the lock this refresher then waits on: delete,
    // the profile's new instance, then the new pair. Adopting that pair here
    // would send the other instance's bearer to this one.
    const holding = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<void>();
    const login = withCredentialsLock(async () => {
      holding.resolve();
      await reading.promise;
      await deleteTokens("default");
      await setProfile("default", {
        instance: "https://other.example",
        userId: "u_1",
        email: "a@example.com",
      });
      await saveTokens("default", peerRotatedTokens());
    });
    await holding.promise;
    changeAfterRead(1, () => reading.resolve());
    installFetch(async () => jsonResponse(200, { ok: true }));

    const error = await settle(apiFetchRaw("default", "/api/data"));
    await login;

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AuthError);
    expect((error as Error).message).toContain("changed instance during this command");
    expect(fetchCalls).toHaveLength(0);
    expect((await loadTokens("default"))?.refreshToken).toBe("peer-refresh");
  });

  it("plain read: a login to another instance landing between profile and pair is refused", async () => {
    await seedProfile("default", { access: "access-1", accessExpiresIn: 5 * 60 * 1000 });
    // The reader has read the profile; the login lands, in its own order,
    // before the reader reads the pair, which is then the other instance's.
    const configPath = join(getConfigDir(), "config.toml");
    let landed = false;
    _setKeyringFactoryForTesting((profile) => ({
      setPassword(value: string): void {
        keyring.store.set(profile, value);
      },
      getPassword(): string | null {
        if (!landed) {
          landed = true;
          keyring.store.delete(profile);
          const config = readFileSync(configPath, "utf-8");
          writeFileSync(
            configPath,
            config.replace("https://app.example.com", "https://other.example"),
          );
          keyring.store.set(profile, JSON.stringify(peerRotatedTokens()));
        }
        return keyring.store.get(profile) ?? null;
      },
      deletePassword(): void {
        keyring.store.delete(profile);
      },
    }));
    installFetch(async () => jsonResponse(200, { ok: true }));

    const error = await settle(apiFetchRaw("default", "/api/data"));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AuthError);
    expect((error as Error).message).toContain("changed instance during this command");
    expect(fetchCalls).toHaveLength(0);
  });

  it("a logout that landed meanwhile stays a logout: no redemption, nothing saved back", async () => {
    await seedProfile("default", {
      access: "expired",
      accessExpiresIn: -60_000,
      refresh: "stale-refresh",
    });
    changeAfterRead(1, peerLogsOut);
    installFetch(async () => jsonResponse(200, { ok: true }));

    await expect(apiFetchRaw("default", "/api/data")).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("No credentials"),
    });
    expect(fetchCalls).toHaveLength(0);
    expect(await loadTokens("default")).toBeNull();
  });
});

describe("apiFetchRaw — credentials lock held by another process", () => {
  it("proactive: gives up past the lock timeout without redeeming the token or touching the credentials", async () => {
    await seedProfile("default", { access: "expired", accessExpiresIn: -60_000, refresh: "r" });
    installFetch(async () => jsonResponse(200, {}));
    const release = await holdCredentialsLock();

    // The access token is already expired, so nothing the jumps reach can
    // change the path taken; the refresh token outlives them by days.
    const stopClock = jumpClock();
    let error: unknown;
    try {
      error = await settle(apiFetchRaw("default", "/api/data"));
    } finally {
      stopClock();
      await release();
    }

    expect(error).toBeInstanceOf(FileLockBusyError);
    expect((error as FileLockBusyError).label).toBe("credential update");
    expect(fetchCalls).toHaveLength(0);
    expect((await loadTokens("default"))?.refreshToken).toBe("r");
  });

  it("reactive 401: surfaces the busy lock rather than a 401 that reads as a lost login", async () => {
    await seedProfile("default", {
      access: "access-1",
      accessExpiresIn: 5 * 60 * 1000,
      refresh: "r",
    });
    // The clock jumps only once the request is out: started earlier, it
    // could expire the access token first and send this down the proactive
    // path instead.
    const clock: { stop?: () => void } = {};
    installFetch(async () => {
      clock.stop ??= jumpClock();
      return jsonResponse(401, { error: "invalid_token" });
    });
    const release = await holdCredentialsLock();

    let error: unknown;
    try {
      error = await settle(apiFetchRaw("default", "/api/data"));
    } finally {
      clock.stop?.();
      await release();
    }

    expect(error).toBeInstanceOf(FileLockBusyError);
    expect(fetchCalls.map((c) => c.url)).toEqual(["https://app.example.com/api/data"]);
    expect((await loadTokens("default"))?.refreshToken).toBe("r");
  });
});

describe("apiFetchRaw — a refresh request that never answers", () => {
  it("is sent with an abort signal; its timeout says so, keeps the credentials and is no 401", async () => {
    await seedProfile("default", {
      access: "access-1",
      accessExpiresIn: 5 * 60 * 1000,
      refresh: "r",
    });
    let signal: AbortSignal | null | undefined;
    installFetch(async (url, init) => {
      if (!url.endsWith("/api/auth/cli/token")) {
        return jsonResponse(401, { error: "invalid_token" });
      }
      signal = init?.signal;
      // What the request's own deadline does to a server that never answers;
      // waiting it out for real would hold this test for 20 seconds.
      throw new DOMException("The operation timed out.", "TimeoutError");
    });

    const error = await settle(apiFetchRaw("default", "/api/data"));

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AuthError);
    expect((error as Error).message).toContain("token refresh request");
    expect((error as Error).message).toContain("timed out after 20 s");
    expect((error as Error).message).toContain("credentials were kept");
    // Not "try again": the server may have rotated before the deadline hit.
    expect((error as Error).message).toContain(
      "If the next command reports the session as revoked, run: appstrate login --profile default --instance https://app.example.com",
    );
    expect(((error as Error).cause as DOMException).name).toBe("TimeoutError");
    expect((await loadTokens("default"))?.refreshToken).toBe("r");
    // The lock went with it: the next refresh is not left waiting.
    expect(await withCredentialsLock(async () => "free")).toBe("free");
  });
});

describe("explicit API key helpers", () => {
  const clearEnv = (): void => {
    delete process.env.APPSTRATE_API_KEY;
    delete process.env.APPSTRATE_INSTANCE;
  };
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("explicitApiKey: flag, else env; an empty ENV value means not set", () => {
    expect(explicitApiKey(undefined)).toBeUndefined();
    process.env.APPSTRATE_API_KEY = "";
    expect(explicitApiKey(undefined)).toBeUndefined();
    process.env.APPSTRATE_API_KEY = "apst_env";
    expect(explicitApiKey(undefined)).toBe("apst_env");
    expect(explicitApiKey("apst_flag")).toBe("apst_flag");
  });

  it("explicitApiKey: surrounding whitespace is trimmed; whitespace-only env is unset", () => {
    expect(explicitApiKey(" apst_flag\n")).toBe("apst_flag");
    process.env.APPSTRATE_API_KEY = "apst_env\n";
    expect(explicitApiKey(undefined)).toBe("apst_env");
    process.env.APPSTRATE_API_KEY = " \n";
    expect(explicitApiKey(undefined)).toBeUndefined();
  });

  it("explicitApiKey: an empty flag throws even when the env var holds a key", () => {
    process.env.APPSTRATE_API_KEY = "apst_env";
    expect(() => explicitApiKey("")).toThrow("--api-key is empty");
    expect(() => explicitApiKey("  ")).toThrow("--api-key is empty");
  });

  it("explicitApiKey: a key that is not visible ASCII throws without quoting it", () => {
    for (const bad of ["apst_a\nb", "apst_a b", "\u201capst_ab\u201d", "apst_\u00e9"]) {
      let thrown: unknown;
      try {
        explicitApiKey(bad);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AuthError);
      expect((thrown as Error).message).not.toContain(bad);
      expect((thrown as Error).message).not.toContain("apst_");
    }
    process.env.APPSTRATE_API_KEY = "apst_a\tb";
    expect(() => explicitApiKey(undefined)).toThrow(AuthError);
  });

  it("resolveApiKeyTarget: env instance wins; the profile's pins are not read", async () => {
    await seedLoggedInProfile("default", { orgId: "org_1", spaceId: "spc_1" });
    process.env.APPSTRATE_INSTANCE = "https://ci.example.com";

    expect(await resolveApiKeyTarget(undefined)).toEqual({ instance: "https://ci.example.com" });
  });

  it("resolveApiKeyTarget: no env, no profile → nothing, without throwing", async () => {
    expect(await resolveApiKeyTarget(undefined)).toEqual({ instance: undefined });
  });
});
