// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `commands/token.ts`.
 *
 * Contract:
 *   1. No token plaintext ever reaches stdout or stderr — the whole
 *      point of the command is metadata-only disclosure.
 *   2. Expired access tokens still produce a report (status: expired)
 *      rather than surfacing a keyring scrub null. That means we must
 *      seed tokens that `loadTokens` won't auto-scrub — refresh-expiry
 *      must be in the future, or the token must be legacy (no refresh
 *      fields at all, which keys off access-expiry).
 *   3. A non-JWT access token (legacy 1.x session string) degrades
 *      gracefully: TTL lines still render, the "JWT claims" section
 *      falls back to an explanatory line rather than throwing.
 *   4. Clock-skew warning fires only when the JWT `exp` claim diverges
 *      from the locally stored `expiresAt` by more than 2s.
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
import { tokenCommand } from "../src/commands/token.ts";

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

let tmpDir: string;
let originalXdg: string | undefined;
const originalExit = process.exit;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

let stdoutChunks: string[];
let stderrChunks: string[];

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
  process.exit = ((code: number) => {
    throw new ExitError(code);
  }) as typeof process.exit;
}

function restoreIo(): void {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  process.exit = originalExit;
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return [header, body, "sig"].join(".");
}

async function seedProfile(
  name: string,
  tokens: {
    accessToken: string;
    expiresAt: number;
    refreshToken?: string;
    refreshExpiresAt?: number;
  },
): Promise<void> {
  await setProfile(name, {
    instance: "https://app.example.com",
    userId: "usr_1",
    email: "alice@example.com",
  });
  await saveTokens(name, tokens);
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "appstrate-cli-token-"));
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpDir;
  _setKeyringFactoryForTesting((profile) => new FakeKeyring(profile));
});

afterAll(async () => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  _setKeyringFactoryForTesting(null);
  await rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  FakeKeyring.store.clear();
  captureIo();
});

afterEach(() => {
  restoreIo();
});

describe("token (happy path)", () => {
  it("prints access + refresh TTLs, JWT claims, and never leaks the plaintext", async () => {
    // 15 min access token, 30 day refresh. `iat`/`exp` in the JWT are
    // epoch seconds; the stored copy uses epoch ms. Align both so the
    // clock-skew warning does not fire.
    const accessExp = Date.now() + 15 * 60 * 1000;
    const refreshExp = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const iat = Math.floor((accessExp - 15 * 60 * 1000) / 1000);
    const exp = Math.floor(accessExp / 1000);
    const accessToken = makeJwt({
      iss: "https://app.example.com/api/auth",
      aud: "https://app.example.com/api/auth",
      sub: "usr_abc",
      azp: "appstrate-cli",
      actor_type: "user",
      email: "alice@example.com",
      scope: "cli",
      iat,
      exp,
      jti: "jti-123",
    });
    const refreshToken = "refresh-secret-never-printed";
    await seedProfile("default", {
      accessToken,
      expiresAt: accessExp,
      refreshToken,
      refreshExpiresAt: refreshExp,
    });

    await tokenCommand({ profile: "default" });

    const out = stdoutChunks.join("");
    expect(stderrChunks.join("")).toBe("");

    // Metadata present.
    expect(out).toContain("Profile:           default");
    expect(out).toContain("Instance:          https://app.example.com");
    expect(out).toContain("Access token");
    expect(out).toContain("Status:          fresh");
    expect(out).toMatch(/Expires:\s+in \d+m \d+s/);
    expect(out).toContain("Refresh token");
    expect(out).toContain("Status:          valid");
    expect(out).toMatch(/Expires:\s+in \d+d \d+h/);
    expect(out).toContain("JWT claims");
    expect(out).toContain("iss:             https://app.example.com/api/auth");
    expect(out).toContain("sub:             usr_abc");
    expect(out).toContain("azp:             appstrate-cli");
    expect(out).toContain("actor_type:      user");
    expect(out).toContain("scope:           cli");
    expect(out).toContain("jti:             jti-123");

    // No plaintext leak — neither token body nor refresh.
    expect(out).not.toContain(accessToken);
    expect(out).not.toContain(refreshToken);
    expect(out).not.toContain("refresh-secret-never-printed");
  });

  it("marks the access token `rotating-soon` when less than 30s remain", async () => {
    const accessExp = Date.now() + 20_000; // 20s
    const refreshExp = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const accessToken = makeJwt({
      sub: "usr_abc",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(accessExp / 1000),
    });
    await seedProfile("default", {
      accessToken,
      expiresAt: accessExp,
      refreshToken: "r",
      refreshExpiresAt: refreshExp,
    });

    await tokenCommand({ profile: "default" });

    const out = stdoutChunks.join("");
    expect(out).toContain("Status:          rotating-soon (< 30s remaining)");
  });

  it("marks the access token `expired` when past its TTL, but still prints the claims", async () => {
    const accessExp = Date.now() - 60_000; // 1 min ago
    const refreshExp = Date.now() + 10 * 24 * 60 * 60 * 1000;
    const accessToken = makeJwt({
      sub: "usr_abc",
      iat: Math.floor((accessExp - 15 * 60 * 1000) / 1000),
      exp: Math.floor(accessExp / 1000),
    });
    await seedProfile("default", {
      accessToken,
      expiresAt: accessExp,
      refreshToken: "r",
      refreshExpiresAt: refreshExp,
    });

    await tokenCommand({ profile: "default" });

    const out = stdoutChunks.join("");
    expect(out).toContain("Status:          expired (next call will trigger rotation)");
    expect(out).toMatch(/Expires:\s+\d+m \d+s ago/);
    // Claims still render — the expiry status doesn't suppress diagnostics.
    expect(out).toContain("sub:             usr_abc");
  });

  it("marks the refresh token `expiring-soon` when less than 24h remain", async () => {
    const accessExp = Date.now() + 15 * 60 * 1000;
    const refreshExp = Date.now() + 2 * 60 * 60 * 1000; // 2h
    const accessToken = makeJwt({
      sub: "usr_abc",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(accessExp / 1000),
    });
    await seedProfile("default", {
      accessToken,
      expiresAt: accessExp,
      refreshToken: "r",
      refreshExpiresAt: refreshExp,
    });

    await tokenCommand({ profile: "default" });

    const out = stdoutChunks.join("");
    expect(out).toContain("Status:          expiring-soon (< 24h remaining)");
  });

  it("flags clock skew when JWT `exp` diverges from stored `expiresAt` by > 2s", async () => {
    // Store access token with a 10-minute expiry, but mint the JWT with
    // a mismatched `exp` claim 30 seconds earlier. The stored value is
    // what api.ts uses for proactive rotation — the warning points that
    // out.
    const accessExpStored = Date.now() + 10 * 60 * 1000;
    const accessToken = makeJwt({
      sub: "usr_abc",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor((accessExpStored - 30_000) / 1000),
    });
    await seedProfile("default", {
      accessToken,
      expiresAt: accessExpStored,
      refreshToken: "r",
      refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });

    await tokenCommand({ profile: "default" });

    const out = stdoutChunks.join("");
    expect(out).toMatch(/JWT `exp` and stored `expiresAt` differ by \d+s/);
  });

  it("falls back to a clear message when the access token is not a JWT (legacy 1.x session)", async () => {
    const accessExp = Date.now() + 15 * 60 * 1000;
    await seedProfile("default", {
      accessToken: "legacy-session-not-a-jwt",
      expiresAt: accessExp,
      // Legacy row: no refresh.
    });

    await tokenCommand({ profile: "default" });

    const out = stdoutChunks.join("");
    expect(stderrChunks.join("")).toBe("");
    // TTL lines still render.
    expect(out).toContain("Access token");
    expect(out).toContain("Status:          fresh");
    // Refresh section explicitly calls out the legacy absence.
    expect(out).toContain("not stored (legacy 1.x credentials");
    // Claims fall back to the explanatory line, not an exception.
    expect(out).toContain("JWT claims:        unavailable");
    expect(out).not.toContain("legacy-session-not-a-jwt"); // still no plaintext
  });
});

describe("token (error paths)", () => {
  it("exits 1 with a clear hint when the profile is not configured", async () => {
    let exitCode: number | undefined;
    try {
      await tokenCommand({ profile: "missing-profile" });
    } catch (err) {
      if (err instanceof ExitError) exitCode = err.code;
      else throw err;
    }
    expect(exitCode).toBe(1);
    expect(stderrChunks.join("")).toContain(`Profile "missing-profile" not configured`);
    expect(stdoutChunks.join("")).toBe("");
  });

  it("exits 1 with a clear hint when the profile exists but has no stored tokens", async () => {
    await setProfile("default", {
      instance: "https://app.example.com",
      userId: "usr_1",
      email: "alice@example.com",
    });

    let exitCode: number | undefined;
    try {
      await tokenCommand({ profile: "default" });
    } catch (err) {
      if (err instanceof ExitError) exitCode = err.code;
      else throw err;
    }
    expect(exitCode).toBe(1);
    expect(stderrChunks.join("")).toContain(`No tokens stored for profile "default"`);
  });
});
