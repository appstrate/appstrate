// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `commands/whoami.ts`.
 *
 * Contract we care about:
 *   1. A valid token + a server that returns a profile MUST produce a
 *      stdout summary keyed on the SERVER'S email — not the copy
 *      cached in `config.toml` at login time. If the user changed
 *      their email in the dashboard since last login, `whoami` must
 *      surface the fresh value.
 *   2. A server 401 (revoked / rotated / expired session) MUST route
 *      through the `AuthError` / `apiFetch` error path and produce a
 *      re-login hint on stderr + exit 1.
 *   3. Unconfigured profile → stderr error naming the missing
 *      profile + exit 1 (no network call).
 *   4. Unreachable server (e.g. wrong port, TCP reset) → stderr error
 *      + exit 1, local state unaffected.
 *
 * Pattern follows `logout.test.ts`: in-memory keyring + global fetch
 * stub + `XDG_CONFIG_HOME` pointed at a tmpdir. Uses an ephemeral
 * `Bun.serve()` only for the "unreachable" test (we close it and reuse
 * its port) — every other test runs through the fetch stub so we can
 * assert request shape without binding to a real socket.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _setKeyringFactoryForTesting,
  saveTokens,
  type KeyringHandle,
} from "../src/lib/keyring.ts";
import { setProfile } from "../src/lib/config.ts";
import { whoamiCommand } from "../src/commands/whoami.ts";

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
let originalXdg: string | undefined;
const originalFetch = globalThis.fetch;
const originalExit = process.exit;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

let fetchCalls: FetchCall[];
let stdoutChunks: string[];
let stderrChunks: string[];

function installFetch(responder: (url: string, init?: RequestInit) => Promise<Response>): void {
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    fetchCalls.push({
      url,
      method: init?.method,
      auth: headers.Authorization ?? null,
    });
    return responder(url, init);
  };
  globalThis.fetch = stub as unknown as typeof fetch;
}

/**
 * Capture stdout + stderr without leaking to the test runner's output,
 * and turn `process.exit` into a throwable so we can assert the
 * exit-code path without killing the test worker. `whoamiCommand` only
 * uses `process.exit(1)` on error branches; the happy path returns
 * normally.
 */
class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code}) called`);
  }
}

function captureIo(): void {
  stdoutChunks = [];
  stderrChunks = [];
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stderr.write;
  // `throw` instead of `return` so the rest of `whoamiCommand` doesn't
  // execute after what would have been a fatal exit. This mirrors real
  // process semantics closely enough for the assertions we care about.
  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number): never => {
    throw new ExitError(code ?? 0);
  }) as (code?: number) => never;
}

beforeAll(() => {
  originalXdg = process.env.XDG_CONFIG_HOME;
});

afterAll(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
});

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "appstrate-cli-whoami-"));
  process.env.XDG_CONFIG_HOME = tmpDir;
  FakeKeyring.store.clear();
  _setKeyringFactoryForTesting((p) => new FakeKeyring(p));
  fetchCalls = [];
  captureIo();
});

afterEach(async () => {
  _setKeyringFactoryForTesting(null);
  globalThis.fetch = originalFetch;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  (process as unknown as { exit: typeof originalExit }).exit = originalExit;
  await rm(tmpDir, { recursive: true, force: true });
});

async function seedLoggedInProfile(
  name: string,
  overrides: { email?: string; instance?: string } = {},
): Promise<void> {
  await setProfile(name, {
    instance: overrides.instance ?? "https://app.example.com",
    userId: "u_1",
    email: overrides.email ?? "stale@example.com",
  });
  await saveTokens(name, {
    accessToken: "tok-abc",
    expiresAt: Date.now() + 15 * 60 * 1000,
    refreshToken: "rt-xyz",
    refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
}

describe("whoami (happy path)", () => {
  it("prints the SERVER-returned email, not the cached config.toml email", async () => {
    // Seed with a deliberately stale email so we can tell which source
    // ended up on stdout.
    await seedLoggedInProfile("default", { email: "stale@example.com" });
    installFetch(async (url) => {
      expect(url).toBe("https://app.example.com/api/profile");
      return new Response(
        JSON.stringify({
          id: "u_1",
          displayName: "Alice",
          language: "en",
          email: "alice@example.com",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    await whoamiCommand({ profile: "default" });

    const out = stdoutChunks.join("");
    expect(out).toContain("Profile:  default");
    expect(out).toContain("Instance: https://app.example.com");
    // Server-side identity wins over the stale cached email.
    expect(out).toContain("User:     alice@example.com");
    expect(out).not.toContain("stale@example.com");
    expect(out).toContain("Name:     Alice");
    expect(stderrChunks.join("")).toBe("");
  });

  it("falls back to server `name` when `displayName` is null (fresh signup, no dashboard customization)", async () => {
    // A user who just signed up has `user.name` populated from the
    // signup form but has never set a `profiles.display_name`. Whoami
    // must still surface a Name line — the JWT carries `name`, but the
    // source of truth is the server response, so we read it back from
    // `/api/profile` rather than decoding the JWT a second time.
    await seedLoggedInProfile("default");
    installFetch(
      async () =>
        new Response(
          JSON.stringify({
            id: "u_1",
            displayName: null,
            language: "fr",
            email: "fresh@example.com",
            name: "Fresh User",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    await whoamiCommand({ profile: "default" });

    const out = stdoutChunks.join("");
    expect(out).toContain("Name:     Fresh User");
  });

  it("omits the Name line entirely when both displayName and name are null", async () => {
    await seedLoggedInProfile("default");
    installFetch(
      async () =>
        new Response(
          JSON.stringify({
            id: "u_1",
            displayName: null,
            language: "fr",
            email: "anon@example.com",
            name: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    await whoamiCommand({ profile: "default" });

    const out = stdoutChunks.join("");
    expect(out).not.toContain("Name:");
    // User line is still present — email is the stronger identity.
    expect(out).toContain("User:     anon@example.com");
  });

  it("sends the stored Bearer token on /api/profile (JWT path, not cookies)", async () => {
    await seedLoggedInProfile("default");
    installFetch(
      async () =>
        new Response(
          JSON.stringify({ id: "u_1", displayName: "A", language: "en", email: "a@example.com" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    await whoamiCommand({ profile: "default" });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.auth).toBe("Bearer tok-abc");
  });
});

describe("whoami (error paths)", () => {
  it("reports a re-login hint and exits 1 when the server returns 401", async () => {
    await seedLoggedInProfile("default");
    // Legacy session (no refreshToken) avoids the reactive-refresh
    // branch and routes the 401 straight into apiFetch's AuthError.
    FakeKeyring.store.clear();
    await saveTokens("default", {
      accessToken: "tok-abc",
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    installFetch(
      async () =>
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    );

    let exitCode: number | undefined;
    try {
      await whoamiCommand({ profile: "default" });
    } catch (err) {
      if (err instanceof ExitError) exitCode = err.code;
      else throw err;
    }

    expect(exitCode).toBe(1);
    const err = stderrChunks.join("");
    // AuthError message from `apiFetch` — user-actionable re-login hint.
    expect(err).toMatch(/appstrate login/);
    expect(stdoutChunks.join("")).toBe("");
  });

  it("exits 1 with a 'Profile ... not configured' message when the profile doesn't exist (no network)", async () => {
    installFetch(async () => new Response("should not be reached", { status: 500 }));

    let exitCode: number | undefined;
    try {
      await whoamiCommand({ profile: "ghost" });
    } catch (err) {
      if (err instanceof ExitError) exitCode = err.code;
      else throw err;
    }

    expect(exitCode).toBe(1);
    expect(stderrChunks.join("")).toContain('Profile "ghost" not configured');
    expect(fetchCalls).toHaveLength(0);
  });

  it("exits 1 with an error message when the server is unreachable (fetch throws)", async () => {
    await seedLoggedInProfile("default");
    installFetch(async () => {
      throw new TypeError("fetch failed");
    });

    let exitCode: number | undefined;
    try {
      await whoamiCommand({ profile: "default" });
    } catch (err) {
      if (err instanceof ExitError) exitCode = err.code;
      else throw err;
    }

    expect(exitCode).toBe(1);
    const err = stderrChunks.join("");
    // `formatError` passes plain `Error` through as .message.
    expect(err).toContain("fetch failed");
  });
});
