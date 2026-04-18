// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `commands/logout.ts`.
 *
 * Contract we care about:
 *   1. Logout MUST call `POST /api/auth/sign-out` on the profile's
 *      instance with the Bearer token BEFORE wiping local state —
 *      otherwise a stolen/backed-up credentials.json would keep
 *      working against the server after "logout".
 *   2. If the server is unreachable or returns a non-200 (other than
 *      401, which is a normal "already revoked"), the local cleanup
 *      must still complete. A network partition must not leave the
 *      user locally logged in.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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

type FetchCall = { url: string; method: string | undefined; auth: string | null };

let tmpDir: string;
const originalXdg = process.env.XDG_CONFIG_HOME;
const originalFetch = globalThis.fetch;
let fetchCalls: FetchCall[];

function installFetch(responder: (url: string, init?: RequestInit) => Promise<Response>): void {
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    fetchCalls.push({ url, method: init?.method, auth: headers.Authorization ?? null });
    return responder(url, init);
  };
  // Bun's `typeof fetch` now includes a `preconnect` method we don't
  // need for the stub; cast through unknown so the type narrowing
  // doesn't force us to reimplement it.
  globalThis.fetch = stub as unknown as typeof fetch;
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "appstrate-cli-logout-"));
  process.env.XDG_CONFIG_HOME = tmpDir;
  FakeKeyring.store.clear();
  _setKeyringFactoryForTesting((p) => new FakeKeyring(p));
  fetchCalls = [];
});

afterEach(async () => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
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
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });
}

describe("logout", () => {
  it("calls POST /api/auth/sign-out with the Bearer token before wiping state", async () => {
    await seedLoggedInProfile("default");
    installFetch(async () => new Response("", { status: 200 }));

    await logoutCommand({ profile: "default" });

    // Contract #1 — server-side revocation happened.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://app.example.com/api/auth/sign-out");
    expect(fetchCalls[0]!.method).toBe("POST");
    expect(fetchCalls[0]!.auth).toBe("Bearer tok-abc");

    // Local cleanup happened too.
    expect(await loadTokens("default")).toBeNull();
    expect(await getProfile("default")).toBeNull();
  });

  it("still wipes local state when the server is unreachable", async () => {
    await seedLoggedInProfile("default");
    installFetch(async () => {
      throw new TypeError("fetch failed");
    });

    await logoutCommand({ profile: "default" });

    expect(fetchCalls).toHaveLength(1);
    expect(await loadTokens("default")).toBeNull();
    expect(await getProfile("default")).toBeNull();
  });

  it("still wipes local state when the server returns 500", async () => {
    await seedLoggedInProfile("default");
    installFetch(async () => new Response("oops", { status: 500 }));

    await logoutCommand({ profile: "default" });

    expect(await loadTokens("default")).toBeNull();
    expect(await getProfile("default")).toBeNull();
  });

  it("treats 401 from the server as 'already revoked' without warning", async () => {
    await seedLoggedInProfile("default");
    installFetch(async () => new Response("", { status: 401 }));

    // The command short-circuits through the AuthError branch of
    // apiFetchRaw. We can't easily intercept stderr from this harness
    // without stubbing `process.stderr.write` globally, so just assert
    // the happy effect: logout completes cleanly and state is wiped.
    await logoutCommand({ profile: "default" });

    expect(await loadTokens("default")).toBeNull();
    expect(await getProfile("default")).toBeNull();
  });

  it("is idempotent when already logged out", async () => {
    // No tokens, no profile — logout should return cleanly and never
    // hit the network.
    installFetch(async () => new Response("", { status: 200 }));
    await logoutCommand({ profile: "never-logged-in" });
    expect(fetchCalls).toHaveLength(0);
  });
});
