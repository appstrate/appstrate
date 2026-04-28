// SPDX-License-Identifier: Apache-2.0

/**
 * Crypto secret generation + `.env` materialization for the install
 * flow.
 *
 * Every install writes the same base set of Better Auth / connection
 * secrets; Docker tiers add PostgreSQL + (for Tier 3) MinIO passwords
 * on top. All values are generated with `node:crypto.randomBytes` —
 * never derived from hostname, timestamp, or env. A fresh install gets
 * fresh secrets; re-running `install` at the same directory regenerates
 * (and the caller is expected to warn about data reset).
 */

import { randomBytes } from "node:crypto";
import { resolveDockerImageTag } from "../version.ts";

/**
 * Supported tier identifiers. `Tier` matches the `--tier` flag values
 * and the names of the embedded `docker-compose.tier*.yml` templates.
 */
export type Tier = 0 | 1 | 2 | 3;

/**
 * `.env` entries as a plain dict so callers can render them with a
 * trivial `Object.entries().map(...).join("\n")`. We keep the type
 * `Record<string, string>` rather than a per-tier discriminated union
 * because `.env` consumers read strings all the way down and the extra
 * typing would be noise for a one-shot materialization.
 */
export type EnvVars = Record<string, string>;

/** 32 random bytes → hex (64 chars). Used for Better Auth session signing, run-token HMAC, upload signing. */
function hex32(): string {
  return randomBytes(32).toString("hex");
}

/** 32 random bytes → base64 (44 chars with padding). Used for AES-256-GCM key (CONNECTION_ENCRYPTION_KEY). */
function base64Key32(): string {
  return randomBytes(32).toString("base64");
}

/** 24 random bytes → base64url (32 chars, URL-safe). Used for DB / object-store passwords. */
function base64urlPassword24(): string {
  return randomBytes(24)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * 32 random bytes → base64url (43 chars, URL-safe). One-shot redemption
 * token written to `.env` as `AUTH_BOOTSTRAP_TOKEN` when an unattended
 * install lands without a named owner email (#344 Layer 2b).
 *
 * 256 bits of entropy — brute-force exclu. Generated client-side at
 * install time; the platform reads it at boot, holds it in memory, and
 * clears it once redeemed via `POST /api/auth/bootstrap/redeem`.
 */
export function generateBootstrapToken(): string {
  return randomBytes(32)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Optional host-port overrides written into `.env`. `port` goes in as
 * `PORT=...`; compose files interpolate it via `${PORT:-3000}`, Bun
 * picks it up automatically on `bun run dev`. `minioConsolePort` is
 * only meaningful on Tier 3 (`${MINIO_CONSOLE_PORT:-9001}`); it is
 * ignored on lower tiers to avoid polluting `.env` with dead keys.
 *
 * Defaults are elided (not written) so a vanilla install produces the
 * same `.env` as before — no churn, no diff noise.
 */
export interface PortOverrides {
  port?: number;
  minioConsolePort?: number;
}

/**
 * Optional self-hosting closed-mode bootstrap (issue #228). When set,
 * the install writes the AUTH_DISABLE_SIGNUP / AUTH_DISABLE_ORG_CREATION
 * pair plus AUTH_BOOTSTRAP_OWNER_EMAIL into the generated `.env`, so
 * the operator's first signup with that email auto-creates the root
 * organization and the rest of the world is locked out by default.
 *
 * Drives both the interactive prompt path (`appstrate install` ⇒
 * "Configure invitation-only mode now?") and the non-interactive path
 * (`APPSTRATE_BOOTSTRAP_OWNER_EMAIL=… curl|bash`). Empty / undefined →
 * open mode (status quo).
 */
export interface BootstrapOverrides {
  bootstrapOwnerEmail?: string;
  /** Org name shown in the dashboard. Defaults to "Default" when unset. */
  bootstrapOrgName?: string;
  /**
   * One-shot redemption token (issue #344 Layer 2b). Set when the
   * install runs unattended (`--yes` / no-TTY) without an
   * `APPSTRATE_BOOTSTRAP_OWNER_EMAIL` override — the alternative would
   * be silently shipping an open instance (the historical default).
   *
   * Mutually exclusive with `bootstrapOwnerEmail`: a named owner closes
   * the loop directly, a token closes it lazily on first redemption.
   * When this field is set the install writes:
   *   AUTH_DISABLE_SIGNUP=true
   *   AUTH_DISABLE_ORG_CREATION=true
   *   AUTH_BOOTSTRAP_TOKEN=<token>
   * The CLI prints a banner with the redemption URL + token at the end
   * of the install so the operator can claim ownership of the instance.
   */
  bootstrapToken?: string;
}

/** Minimal RFC 5322 sanity check — sufficient for an install-time guard. */
export function isValidBootstrapEmail(value: string): boolean {
  // Single `@`, non-empty local part, dotted domain, no whitespace.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Build the `.env` variable set for the given tier. All tiers share
 * the core Better Auth / connection-encryption secrets; Docker tiers
 * (1/2/3) add infra passwords.
 */
export function generateEnvForTier(
  tier: Tier,
  appUrl = "http://localhost:3000",
  ports: PortOverrides = {},
  bootstrap: BootstrapOverrides = {},
): EnvVars {
  const env: EnvVars = {
    APP_URL: appUrl,
    TRUSTED_ORIGINS: appUrl,
    BETTER_AUTH_SECRET: hex32(),
    CONNECTION_ENCRYPTION_KEY: base64Key32(),
    RUN_TOKEN_SECRET: hex32(),
    UPLOAD_SIGNING_SECRET: hex32(),
  };

  if (ports.port !== undefined && ports.port !== 3000) {
    env.PORT = String(ports.port);
  }

  if (bootstrap.bootstrapOwnerEmail) {
    // Self-hosting closed mode (issue #228). The signup gate lets this
    // email through even with AUTH_DISABLE_SIGNUP=true, and the
    // after-hook auto-provisions the root org on first signup. The
    // owner is also added to PLATFORM_ADMIN_EMAILS so they keep
    // org-creation rights after the bootstrap (otherwise they'd be
    // locked out of `POST /api/orgs` for any future tenant org).
    env.AUTH_DISABLE_SIGNUP = "true";
    env.AUTH_DISABLE_ORG_CREATION = "true";
    env.AUTH_PLATFORM_ADMIN_EMAILS = bootstrap.bootstrapOwnerEmail;
    env.AUTH_BOOTSTRAP_OWNER_EMAIL = bootstrap.bootstrapOwnerEmail;
    if (bootstrap.bootstrapOrgName) {
      env.AUTH_BOOTSTRAP_ORG_NAME = bootstrap.bootstrapOrgName;
    }
  } else if (bootstrap.bootstrapToken) {
    // Closed-by-default unattended install (issue #344 Layer 2b). No
    // named owner yet — the operator claims the instance later by
    // POSTing the token to `/api/auth/bootstrap/redeem`. Until then
    // signup is locked, so a fresh `curl … | bash -s -- --yes` on a
    // public VPS is no longer silently exposed.
    env.AUTH_DISABLE_SIGNUP = "true";
    env.AUTH_DISABLE_ORG_CREATION = "true";
    env.AUTH_BOOTSTRAP_TOKEN = bootstrap.bootstrapToken;
    if (bootstrap.bootstrapOrgName) {
      env.AUTH_BOOTSTRAP_ORG_NAME = bootstrap.bootstrapOrgName;
    }
  }

  if (tier === 0) {
    // Tier 0 runs directly against PGlite + filesystem, no infra passwords needed.
    return env;
  }

  // Tiers 1/2/3: pin the image tag to the CLI's own version (lockstep
  // per ADR-006) so `docker compose pull` can't silently drag in a
  // newer or older appstrate/appstrate-pi/appstrate-sidecar image than
  // the CLI was built to orchestrate. Without this, compose falls back
  // to `${APPSTRATE_VERSION:-latest}` — and `latest` may not exist on
  // GHCR during pre-release trains.
  env.APPSTRATE_VERSION = resolveDockerImageTag();

  // Tiers 1/2/3: Postgres password is always required.
  env.POSTGRES_USER = "appstrate";
  env.POSTGRES_PASSWORD = base64urlPassword24();

  if (tier === 3) {
    // MinIO creds only on Tier 3.
    env.MINIO_ROOT_USER = "appstrate";
    env.MINIO_ROOT_PASSWORD = base64urlPassword24();
    env.S3_BUCKET = "appstrate";
    env.S3_REGION = "us-east-1";
    if (ports.minioConsolePort !== undefined && ports.minioConsolePort !== 9001) {
      env.MINIO_CONSOLE_PORT = String(ports.minioConsolePort);
    }
  }

  return env;
}

/**
 * Render an `EnvVars` dict to a `.env` file body. Values are written
 * verbatim (no quoting) because every generator above returns URL/
 * ASCII-safe output — no whitespace, no `#`, no `"`. Keys are sorted
 * so the output is stable across invocations (easier to diff when
 * re-generating).
 *
 * Footer branches on the closed-mode shape:
 *   - `AUTH_BOOTSTRAP_OWNER_EMAIL` set → no footer (lockdown already configured).
 *   - `AUTH_BOOTSTRAP_TOKEN` set → token-redemption pointer for the operator.
 *   - neither → 3-line pointer to AUTH_MODES.md for the self-hoster who'll
 *     edit `.env` anyway and wants to discover the feature.
 */
export function renderEnvFile(env: EnvVars): string {
  const lines = Object.keys(env)
    .sort()
    .map((key) => `${key}=${env[key]}`);
  let closedModeFooter: string;
  if (env.AUTH_BOOTSTRAP_OWNER_EMAIL) {
    closedModeFooter = "";
  } else if (env.AUTH_BOOTSTRAP_TOKEN) {
    closedModeFooter =
      `\n# ─── Bootstrap token redemption (closed-by-default install) ───\n` +
      `# Public signup is disabled. Claim ownership of this instance via:\n` +
      `#   ${env.APP_URL ?? "http://localhost:3000"}/claim\n` +
      `# Token above (AUTH_BOOTSTRAP_TOKEN) is single-use and self-clears\n` +
      `# once redeemed. See examples/self-hosting/AUTH_MODES.md.\n`;
  } else {
    closedModeFooter =
      `\n# ─── Auth lockdown (optional, self-hosting) ───\n` +
      `# Invitation-only mode + bootstrap owner: see\n` +
      `# examples/self-hosting/AUTH_MODES.md\n`;
  }
  return `# Appstrate — generated by \`appstrate install\`\n# DO NOT commit this file; it contains cryptographic secrets.\n\n${lines.join("\n")}\n${closedModeFooter}`;
}
