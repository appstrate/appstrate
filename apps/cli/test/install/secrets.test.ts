// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the install secrets generator.
 *
 * Focuses on:
 *   - Per-tier envelope (which keys are present for tier N)
 *   - Value formats (hex length, base64 length, base64url charset)
 *   - Determinism of randomness (each call produces a different value)
 *   - `renderEnvFile` output stability + safe characters
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  generateEnvForTier,
  isValidBootstrapEmail,
  renderEnvFile,
  type EnvVars,
} from "../../src/lib/install/secrets.ts";

const HEX_64 = /^[0-9a-f]{64}$/;
// `randomBytes(32).toString("base64")` is always 44 chars including padding.
const BASE64_KEY_32 = /^[A-Za-z0-9+/]{43}=$/;
// `randomBytes(24)` as base64url has no padding; 24 bytes → 32 chars.
const BASE64URL_PASSWORD_24 = /^[A-Za-z0-9_-]{32}$/;

// Workspace CLI_VERSION is "0.0.0" — a dev build. By contract,
// `generateEnvForTier` on docker tiers refuses to guess an image tag for
// a dev build. Provide an explicit override for every test by default;
// the two tests that assert the throw behavior clear the override before
// running and restore it after.
const previousAppstrateVersion = process.env.APPSTRATE_VERSION;
beforeEach(() => {
  process.env.APPSTRATE_VERSION = "1.2.3";
});
afterEach(() => {
  if (previousAppstrateVersion === undefined) delete process.env.APPSTRATE_VERSION;
  else process.env.APPSTRATE_VERSION = previousAppstrateVersion;
});

describe("generateEnvForTier — tier envelope", () => {
  it("Tier 0 contains only the core secrets (no infra passwords, no APPSTRATE_VERSION)", () => {
    const env = generateEnvForTier(0);
    expect(Object.keys(env).sort()).toEqual(
      [
        "APP_URL",
        "BETTER_AUTH_SECRET",
        "CONNECTION_ENCRYPTION_KEY",
        "RUN_TOKEN_SECRET",
        "TRUSTED_ORIGINS",
        "UPLOAD_SIGNING_SECRET",
      ].sort(),
    );
    // Tier 0 runs bun directly — no compose templates, no image pin.
    expect(env.APPSTRATE_VERSION).toBeUndefined();
  });

  it("Tier 1 adds Postgres user + password + APPSTRATE_VERSION, no Redis/MinIO", () => {
    const env = generateEnvForTier(1);
    expect(env.POSTGRES_USER).toBe("appstrate");
    expect(env.POSTGRES_PASSWORD).toBeDefined();
    expect(env.MINIO_ROOT_PASSWORD).toBeUndefined();
    expect(env.APPSTRATE_VERSION).toBe("1.2.3");
  });

  it("Tier 2 matches Tier 1 + image pin (Redis has no password by default)", () => {
    const env = generateEnvForTier(2);
    expect(env.POSTGRES_PASSWORD).toBeDefined();
    expect(env.MINIO_ROOT_PASSWORD).toBeUndefined();
    expect(env.APPSTRATE_VERSION).toBe("1.2.3");
  });

  it("Tier 3 adds MinIO creds + bucket + region + APPSTRATE_VERSION", () => {
    const env = generateEnvForTier(3);
    expect(env.POSTGRES_PASSWORD).toBeDefined();
    expect(env.MINIO_ROOT_USER).toBe("appstrate");
    expect(env.MINIO_ROOT_PASSWORD).toBeDefined();
    expect(env.S3_BUCKET).toBe("appstrate");
    expect(env.S3_REGION).toBe("us-east-1");
    expect(env.APPSTRATE_VERSION).toBe("1.2.3");
  });

  it("dev CLI without APPSTRATE_VERSION override throws on docker tiers", () => {
    // Clear the override the outer `beforeEach` installed.
    delete process.env.APPSTRATE_VERSION;
    expect(() => generateEnvForTier(1)).toThrow(/dev build of the CLI/);
    expect(() => generateEnvForTier(2)).toThrow(/dev build of the CLI/);
    expect(() => generateEnvForTier(3)).toThrow(/dev build of the CLI/);
  });

  it("dev CLI still builds tier 0 (no image pin needed)", () => {
    delete process.env.APPSTRATE_VERSION;
    const env = generateEnvForTier(0);
    expect(env.APPSTRATE_VERSION).toBeUndefined();
    expect(env.BETTER_AUTH_SECRET).toBeDefined();
  });
});

describe("generateEnvForTier — value formats", () => {
  it("BETTER_AUTH_SECRET / RUN_TOKEN_SECRET / UPLOAD_SIGNING_SECRET are 64-char hex", () => {
    const env = generateEnvForTier(0);
    expect(env.BETTER_AUTH_SECRET).toMatch(HEX_64);
    expect(env.RUN_TOKEN_SECRET).toMatch(HEX_64);
    expect(env.UPLOAD_SIGNING_SECRET).toMatch(HEX_64);
  });

  it("CONNECTION_ENCRYPTION_KEY is base64-encoded 32 bytes (44 chars with padding)", () => {
    const env = generateEnvForTier(0);
    expect(env.CONNECTION_ENCRYPTION_KEY).toMatch(BASE64_KEY_32);
  });

  it("Postgres / MinIO passwords are url-safe base64 of 24 bytes", () => {
    const env = generateEnvForTier(3);
    expect(env.POSTGRES_PASSWORD).toMatch(BASE64URL_PASSWORD_24);
    expect(env.MINIO_ROOT_PASSWORD).toMatch(BASE64URL_PASSWORD_24);
  });

  it("APP_URL defaults to http://localhost:3000 and is reflected in TRUSTED_ORIGINS", () => {
    const env = generateEnvForTier(0);
    expect(env.APP_URL).toBe("http://localhost:3000");
    expect(env.TRUSTED_ORIGINS).toBe("http://localhost:3000");
  });

  it("APP_URL can be overridden and TRUSTED_ORIGINS tracks it", () => {
    const env = generateEnvForTier(0, "https://my.appstrate.io");
    expect(env.APP_URL).toBe("https://my.appstrate.io");
    expect(env.TRUSTED_ORIGINS).toBe("https://my.appstrate.io");
  });
});

describe("generateEnvForTier — port overrides", () => {
  it("omits PORT when the default (3000) is requested — keeps the .env minimal", () => {
    const env = generateEnvForTier(0, "http://localhost:3000", { port: 3000 });
    expect(env.PORT).toBeUndefined();
  });

  it("emits PORT when a non-default port is requested (Tier 0)", () => {
    const env = generateEnvForTier(0, "http://localhost:4000", { port: 4000 });
    expect(env.PORT).toBe("4000");
  });

  it("emits PORT on Docker tiers too (compose interpolates ${PORT:-3000})", () => {
    const env = generateEnvForTier(2, "http://localhost:5000", { port: 5000 });
    expect(env.PORT).toBe("5000");
  });

  it("emits MINIO_CONSOLE_PORT only on Tier 3 + only when non-default", () => {
    const t3 = generateEnvForTier(3, "http://localhost:3000", { minioConsolePort: 9100 });
    expect(t3.MINIO_CONSOLE_PORT).toBe("9100");

    const t3Default = generateEnvForTier(3, "http://localhost:3000", { minioConsolePort: 9001 });
    expect(t3Default.MINIO_CONSOLE_PORT).toBeUndefined();

    const t1 = generateEnvForTier(1, "http://localhost:3000", { minioConsolePort: 9100 });
    expect(t1.MINIO_CONSOLE_PORT).toBeUndefined();
  });
});

describe("generateEnvForTier — randomness", () => {
  it("produces a different secret set on each call", () => {
    const a = generateEnvForTier(3);
    const b = generateEnvForTier(3);
    expect(a.BETTER_AUTH_SECRET).not.toBe(b.BETTER_AUTH_SECRET);
    expect(a.CONNECTION_ENCRYPTION_KEY).not.toBe(b.CONNECTION_ENCRYPTION_KEY);
    expect(a.POSTGRES_PASSWORD).not.toBe(b.POSTGRES_PASSWORD);
    expect(a.MINIO_ROOT_PASSWORD).not.toBe(b.MINIO_ROOT_PASSWORD);
    expect(a.RUN_TOKEN_SECRET).not.toBe(b.RUN_TOKEN_SECRET);
    expect(a.UPLOAD_SIGNING_SECRET).not.toBe(b.UPLOAD_SIGNING_SECRET);
  });
});

describe("renderEnvFile", () => {
  const sample: EnvVars = {
    B_SECOND: "bbb",
    A_FIRST: "aaa",
    C_THIRD: "ccc",
  };

  it("sorts keys alphabetically so output is diff-stable", () => {
    const body = renderEnvFile(sample);
    const idxA = body.indexOf("A_FIRST=");
    const idxB = body.indexOf("B_SECOND=");
    const idxC = body.indexOf("C_THIRD=");
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(idxA);
    expect(idxC).toBeGreaterThan(idxB);
  });

  it("emits KEY=value lines with no quoting", () => {
    const body = renderEnvFile(sample);
    expect(body).toContain("A_FIRST=aaa\n");
    expect(body).toContain("B_SECOND=bbb\n");
    expect(body).not.toContain(`"aaa"`);
  });

  it("prefixes a header comment + secret warning", () => {
    const body = renderEnvFile(sample);
    expect(body.startsWith("# Appstrate")).toBe(true);
    expect(body).toContain("DO NOT commit");
  });

  it("round-trips a generated env: every key appears once in order", () => {
    const env = generateEnvForTier(3);
    const body = renderEnvFile(env);
    for (const key of Object.keys(env)) {
      expect(body).toContain(`${key}=${env[key]}\n`);
    }
  });

  it("appends the closed-mode pointer footer when no bootstrap email is set", () => {
    const env = generateEnvForTier(3);
    const body = renderEnvFile(env);
    expect(body).toContain("Auth lockdown (optional, self-hosting)");
    expect(body).toContain("examples/self-hosting/AUTH_MODES.md");
  });

  it("suppresses the footer when AUTH_BOOTSTRAP_OWNER_EMAIL is set", () => {
    const env = generateEnvForTier(
      3,
      "http://localhost:3000",
      {},
      { bootstrapOwnerEmail: "admin@acme.com" },
    );
    const body = renderEnvFile(env);
    expect(body).not.toContain("Auth lockdown (optional");
    expect(body).not.toContain("AUTH_MODES.md");
  });
});

describe("generateEnvForTier — bootstrap (issue #228)", () => {
  it("does NOT emit AUTH_* keys when no bootstrap email is provided", () => {
    const env = generateEnvForTier(3);
    expect(env.AUTH_DISABLE_SIGNUP).toBeUndefined();
    expect(env.AUTH_DISABLE_ORG_CREATION).toBeUndefined();
    expect(env.AUTH_BOOTSTRAP_OWNER_EMAIL).toBeUndefined();
    expect(env.AUTH_PLATFORM_ADMIN_EMAILS).toBeUndefined();
  });

  it("emits the closed-mode trio + admin allowlist when bootstrap email is provided", () => {
    const env = generateEnvForTier(
      3,
      "http://localhost:3000",
      {},
      { bootstrapOwnerEmail: "admin@acme.com" },
    );
    expect(env.AUTH_DISABLE_SIGNUP).toBe("true");
    expect(env.AUTH_DISABLE_ORG_CREATION).toBe("true");
    expect(env.AUTH_BOOTSTRAP_OWNER_EMAIL).toBe("admin@acme.com");
    // Same email is mirrored into PLATFORM_ADMIN_EMAILS so the owner can
    // still call POST /api/orgs after the bootstrap (without it they'd be
    // locked out of creating any future tenant org).
    expect(env.AUTH_PLATFORM_ADMIN_EMAILS).toBe("admin@acme.com");
  });

  it("emits AUTH_BOOTSTRAP_ORG_NAME only when explicitly provided", () => {
    const withName = generateEnvForTier(
      3,
      "http://localhost:3000",
      {},
      { bootstrapOwnerEmail: "admin@acme.com", bootstrapOrgName: "Acme HQ" },
    );
    expect(withName.AUTH_BOOTSTRAP_ORG_NAME).toBe("Acme HQ");

    const withoutName = generateEnvForTier(
      3,
      "http://localhost:3000",
      {},
      { bootstrapOwnerEmail: "admin@acme.com" },
    );
    // Server defaults to "Default" when the env var is absent — keep .env
    // minimal by NOT writing the redundant default.
    expect(withoutName.AUTH_BOOTSTRAP_ORG_NAME).toBeUndefined();
  });

  it("works on Tier 0 too (covers the local-dev IaC pass-through case)", () => {
    const env = generateEnvForTier(
      0,
      "http://localhost:3000",
      {},
      { bootstrapOwnerEmail: "admin@acme.com" },
    );
    expect(env.AUTH_BOOTSTRAP_OWNER_EMAIL).toBe("admin@acme.com");
  });
});

describe("isValidBootstrapEmail", () => {
  it("accepts well-formed emails", () => {
    expect(isValidBootstrapEmail("admin@acme.com")).toBe(true);
    expect(isValidBootstrapEmail("user.name+tag@sub.example.io")).toBe(true);
  });

  it("rejects malformed inputs", () => {
    expect(isValidBootstrapEmail("")).toBe(false);
    expect(isValidBootstrapEmail("noatsign")).toBe(false);
    expect(isValidBootstrapEmail("@no-local.com")).toBe(false);
    expect(isValidBootstrapEmail("trailing@")).toBe(false);
    expect(isValidBootstrapEmail("no-tld@example")).toBe(false);
    expect(isValidBootstrapEmail("white space@example.com")).toBe(false);
  });
});
