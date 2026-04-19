// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `commands/logout.ts`.
 *
 * Contract we care about:
 *   1. Profiles MUST call `POST /api/auth/cli/revoke` so the
 *      refresh-token family is invalidated server-side. Otherwise a
 *      stolen keyring export would still be usable against the server
 *      after "logout".
 *   2. If the server is unreachable or returns a non-200, the local
 *      cleanup must still complete. A network partition must not leave
 *      the user locally logged in.
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
import { setProfile, getProfile } from "../src/lib/config.ts";
import { logoutCommand } from "../src/commands/logout.ts";

// In-memory keyring — same shape as `keyring.test.ts` but scoped to
// this file so test isolation stays clean.
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

type FetchCall = {
  url: string;
  method: string | undefined;
  auth: string | null;
  body: string | null;
};

let tmpDir: string;
// Captured at `beforeAll` rather than module load. If another test file
// running earlier in the same Bun worker mutated `XDG_CONFIG_HOME` and
// forgot to restore it, a module-level capture would snapshot the stale
// value — and our `afterAll` would then write that wrong value back
// into the worker's env, poisoning any test that runs next.
let originalXdg: string | undefined;
const originalFetch = globalThis.fetch;
let fetchCalls: FetchCall[];

function installFetch(responder: (url: string, init?: RequestInit) => Promise<Response>): void {
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? init.body : null;
    fetchCalls.push({
      url,
      method: init?.method,
      auth: headers.Authorization ?? null,
      body,
    });
    return responder(url, init);
  };
  // Bun's `typeof fetch` now includes a `preconnect` method we don't
  // need for the stub; cast through unknown so the type narrowing
  // doesn't force us to reimplement it.
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
  tmpDir = await mkdtemp(join(tmpdir(), "appstrate-cli-logout-"));
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

async function seedLoggedInProfile(name: string): Promise<void> {
  await setProfile(name, {
    instance: "https://app.example.com",
    userId: "u_1",
    email: "a@example.com",
  });
  await saveTokens(name, {
    accessToken: "tok-abc",
    expiresAt: Date.now() + 15 * 60 * 1000,
    refreshToken: "rt-xyz",
    refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
}

describe("logout (with refresh token)", () => {
  it("calls POST /api/auth/cli/revoke with refresh_token + client_id, then wipes state", async () => {
    await seedLoggedInProfile("default");
    installFetch(async () => new Response(JSON.stringify({ revoked: true }), { status: 200 }));

    await logoutCommand({ profile: "default" });

    // Contract #1 — family revocation happened server-side.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://app.example.com/api/auth/cli/revoke");
    expect(fetchCalls[0]!.method).toBe("POST");
    // Form-urlencoded body carries the refresh token + client id.
    const parsed = new URLSearchParams(fetchCalls[0]!.body ?? "");
    expect(parsed.get("token")).toBe("rt-xyz");
    expect(parsed.get("client_id")).toBe("appstrate-cli");
    // Revoke endpoint is unauthenticated (token proves ownership).
    expect(fetchCalls[0]!.auth).toBeNull();

    // Local cleanup happened too.
    expect(await loadTokens("default")).toBeNull();
    expect(await getProfile("default")).toBeNull();
  });

  it("still wipes local state when /cli/revoke fails (network error)", async () => {
    await seedLoggedInProfile("default");
    installFetch(async () => {
      throw new TypeError("fetch failed");
    });

    await logoutCommand({ profile: "default" });

    expect(fetchCalls).toHaveLength(1);
    expect(await loadTokens("default")).toBeNull();
    expect(await getProfile("default")).toBeNull();
  });

  it("still wipes local state when /cli/revoke returns 500", async () => {
    await seedLoggedInProfile("default");
    installFetch(async () => new Response("oops", { status: 500 }));

    await logoutCommand({ profile: "default" });

    expect(await loadTokens("default")).toBeNull();
    expect(await getProfile("default")).toBeNull();
  });

  it("still wipes local state when /cli/revoke returns 401 (already revoked)", async () => {
    await seedLoggedInProfile("default");
    installFetch(
      async () =>
        new Response(JSON.stringify({ error: "invalid_client" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await logoutCommand({ profile: "default" });

    // The 401 branch is benign — warn-and-continue.
    expect(await loadTokens("default")).toBeNull();
    expect(await getProfile("default")).toBeNull();
  });
});

describe("logout (idempotency)", () => {
  it("is idempotent when already logged out (no tokens, no profile)", async () => {
    installFetch(async () => new Response("", { status: 200 }));
    await logoutCommand({ profile: "never-logged-in" });
    expect(fetchCalls).toHaveLength(0);
  });
});
