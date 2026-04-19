// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate token` — print metadata about the access + refresh tokens
 * stored for the active profile. Metadata only: the token plaintext is
 * deliberately never written to stdout/stderr so copy-paste into a
 * terminal buffer, a CI log, or a screen share can't leak a bearer.
 *
 * Why it exists: diagnosing a 401 or a "why did my rotation fire now?"
 * question without this command required reading the keyring by hand,
 * decoding the JWT with an external tool, and comparing `exp` to the
 * local clock. All three steps are mechanical — bake them into a
 * first-class command so the feedback loop for CLI auth issues is a
 * single `appstrate token` away.
 *
 * No network call: this command ONLY inspects local state (keyring +
 * JWT payload). A revoked-server-side refresh token looks healthy
 * here — that's by design. Use `whoami` for a server-authoritative
 * identity check.
 */

import { readConfig, resolveProfileName } from "../lib/config.ts";
import { loadTokens } from "../lib/keyring.ts";
import { decodeJwtPayload } from "../lib/jwt-identity.ts";
import { formatError } from "../lib/ui.ts";

export interface TokenOptions {
  profile?: string;
}

export async function tokenCommand(opts: TokenOptions): Promise<void> {
  const config = await readConfig();
  const profileName = resolveProfileName(opts.profile, config);
  const profile = config.profiles[profileName];

  if (!profile) {
    process.stderr.write(
      `Profile "${profileName}" not configured. Run: appstrate login --profile ${profileName}\n`,
    );
    process.exit(1);
    return;
  }

  try {
    const stored = await loadTokens(profileName);
    if (!stored) {
      process.stderr.write(
        `No tokens stored for profile "${profileName}". Run: appstrate login --profile ${profileName}\n`,
      );
      process.exit(1);
      return;
    }

    const now = Date.now();
    const lines: string[] = [
      `Profile:           ${profileName}`,
      `Instance:          ${profile.instance}`,
      "",
      "Access token",
      `  Status:          ${accessStatus(stored.expiresAt, now)}`,
      `  Expires:         ${formatExpiry(stored.expiresAt, now)}`,
      `  Expires at:      ${new Date(stored.expiresAt).toISOString()}`,
    ];

    lines.push(
      "",
      "Refresh token",
      `  Status:          ${refreshStatus(stored.refreshExpiresAt, now)}`,
      `  Expires:         ${formatExpiry(stored.refreshExpiresAt, now)}`,
      `  Expires at:      ${new Date(stored.refreshExpiresAt).toISOString()}`,
    );

    const claims = safeDecodeClaims(stored.accessToken);
    if (claims) {
      lines.push("", "JWT claims");
      lines.push(`  iss:             ${stringClaim(claims.iss)}`);
      lines.push(`  aud:             ${stringClaim(claims.aud)}`);
      lines.push(`  sub:             ${stringClaim(claims.sub)}`);
      lines.push(`  azp:             ${stringClaim(claims.azp)}`);
      lines.push(`  actor_type:      ${stringClaim(claims.actor_type)}`);
      lines.push(`  scope:           ${scopeClaim(claims.scope)}`);
      lines.push(`  iat:             ${epochClaim(claims.iat)}`);
      lines.push(`  exp:             ${epochClaim(claims.exp)}`);
      lines.push(`  jti:             ${stringClaim(claims.jti)}`);
      // Clock-skew hint: if `exp` from the JWT diverges from the locally
      // stored `expiresAt` by more than 2s, the stored copy was
      // computed wrong at login time (or the system clock moved). Both
      // scenarios are worth surfacing because `api.ts` uses the stored
      // value for proactive rotation decisions.
      if (typeof claims.exp === "number") {
        const jwtExpMs = claims.exp * 1000;
        const delta = Math.abs(jwtExpMs - stored.expiresAt);
        if (delta > 2000) {
          lines.push(
            "",
            `  ⚠  JWT \`exp\` and stored \`expiresAt\` differ by ${Math.round(delta / 1000)}s.`,
            `     The CLI's proactive-rotation decisions key off the stored value;`,
            `     re-run \`appstrate login\` if calls start unexpectedly 401-ing.`,
          );
        }
      }
    } else {
      lines.push("", `JWT claims:        unavailable (token is not a JWT)`);
    }

    process.stdout.write(lines.join("\n") + "\n");
  } catch (err) {
    process.stderr.write(formatError(err) + "\n");
    process.exit(1);
  }
}

function accessStatus(expiresAt: number, now: number): string {
  const remainingMs = expiresAt - now;
  if (remainingMs <= 0) return "expired (next call will trigger rotation)";
  // `api.ts` rotates proactively when the remaining window drops below
  // 30s — match that threshold here so the status reflects the runtime
  // behavior rather than an arbitrary "fresh/stale" cutoff.
  if (remainingMs < 30_000) return "rotating-soon (< 30s remaining)";
  return "fresh";
}

function refreshStatus(refreshExpiresAt: number, now: number): string {
  const remainingMs = refreshExpiresAt - now;
  if (remainingMs <= 0) return "expired (re-run `appstrate login`)";
  // Warn when less than a day is left — a CLI in long-running automation
  // should surface this before the user finds out via a 400 on rotation.
  if (remainingMs < 24 * 60 * 60 * 1000) return "expiring-soon (< 24h remaining)";
  return "valid";
}

function formatExpiry(ms: number, now: number): string {
  const deltaMs = ms - now;
  if (deltaMs <= 0) {
    return `${formatDuration(-deltaMs)} ago`;
  }
  return `in ${formatDuration(deltaMs)}`;
}

/**
 * Human-readable durations — one significant unit above the minute mark,
 * two units below. Mirrors `gh auth status` / `kubectl`'s style: the
 * goal is at-a-glance comprehension, not exactness.
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function safeDecodeClaims(accessToken: string): Record<string, unknown> | null {
  try {
    return decodeJwtPayload(accessToken);
  } catch {
    return null;
  }
}

function stringClaim(v: unknown): string {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number") return String(v);
  return "(missing)";
}

function scopeClaim(v: unknown): string {
  if (typeof v === "string" && v.length > 0) return v;
  // RFC 9068 §3 encodes "no scope" as an omitted claim — surface that
  // explicitly so users don't mistake it for a decoder bug.
  return "(none)";
}

function epochClaim(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "(missing)";
  return `${v} (${new Date(v * 1000).toISOString()})`;
}
