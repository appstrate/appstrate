// SPDX-License-Identifier: Apache-2.0

/**
 * Platform update availability check (issue #694).
 *
 * Polls the GitHub Releases API for the latest published release and compares
 * it with the running build (`APP_VERSION`, stamped into the image at build
 * time). Notification only — upgrades stay host-orchestrated
 * (`docker compose pull && docker compose up -d`).
 *
 * Rate-limit safety: GitHub's unauthenticated API caps at 60 req/h per IP, so
 * the result is cached in memory (success TTL 6 h, failure TTL 30 min) and
 * concurrent callers share one in-flight request. The SPA can therefore poll
 * `GET /api/version` freely — at most one outbound call per TTL window.
 *
 * Opt-out: `UPDATE_CHECK_ENABLED=false` disables the outbound call entirely
 * (some operators want zero egress). Source/dev runs (no `APP_VERSION`) also
 * skip the check — there is no meaningful version to compare.
 */

import semver from "semver";
import { getEnv } from "@appstrate/env";
import { normalizeVersion } from "@appstrate/core/semver";
import { logger } from "../lib/logger.ts";
import { getVersionInfo } from "../lib/version.ts";

const LATEST_RELEASE_URL = "https://api.github.com/repos/appstrate/appstrate/releases/latest";
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000; // 6 h — a few checks per day is plenty
const FAILURE_TTL_MS = 30 * 60 * 1000; // 30 min — retry soon, but never hammer on errors
const FETCH_TIMEOUT_MS = 10_000;

/** Wire shape of the `update` block returned by `GET /api/version` (snake_case). */
export interface UpdateStatus {
  /** False when opted out via env or when the running version is unknown (dev). */
  check_enabled: boolean;
  update_available: boolean;
  /** Latest published release (normalized, no `v` prefix). Null until a check succeeds. */
  latest_version: string | null;
  /** ISO timestamp of the last successful GitHub check. Null until one succeeds. */
  checked_at: string | null;
}

/**
 * True when `latest` is strictly newer than `current` per SemVer 2.0
 * precedence (prerelease identifiers included — `1.0.0-beta.39 > 1.0.0-beta.38`,
 * `1.0.0 > 1.0.0-beta.38`). Invalid input on either side → false (never
 * nag on garbage).
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const c = semver.valid(normalizeVersion(current));
  const l = semver.valid(normalizeVersion(latest));
  if (!c || !l) return false;
  return semver.gt(l, c);
}

/**
 * Fetch the latest release tag from the GitHub Releases API and normalize it
 * (`v1.2.3` → `1.2.3`). Same endpoint/pattern as the CLI's `self-update`
 * (`apps/cli/src/lib/self-update.ts`). Throws on network errors, non-2xx, or
 * a malformed payload — the caller caches the failure.
 */
export async function fetchLatestReleaseVersion(): Promise<string> {
  const res = await fetch(LATEST_RELEASE_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "appstrate-platform-update-check",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`GitHub Releases API responded ${res.status} ${res.statusText}`);
  }
  const parsed: unknown = await res.json();
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { tag_name?: unknown }).tag_name !== "string"
  ) {
    throw new Error("GitHub Releases API response missing tag_name");
  }
  return normalizeVersion((parsed as { tag_name: string }).tag_name);
}

interface UpdateCheckerOptions {
  /** Running release version (normalized or tag form). Null = unknown/dev → check disabled. */
  currentVersion: string | null;
  /** Env opt-out (`UPDATE_CHECK_ENABLED`). */
  enabled: boolean;
  /** Injectable for tests — defaults to the real GitHub fetch. */
  fetchLatest?: () => Promise<string>;
  /** Injectable clock for tests. */
  now?: () => number;
  successTtlMs?: number;
  failureTtlMs?: number;
}

interface CacheEntry {
  /** Null when the last attempt failed (negative cache). */
  latestVersion: string | null;
  /** Epoch ms of the last SUCCESSFUL check (0 = never). */
  checkedAt: number;
  expiresAt: number;
}

/**
 * TTL-cached, single-flight wrapper around the GitHub latest-release lookup.
 * Instantiated once per process via {@link getUpdateChecker}; tests construct
 * their own instances with injected deps.
 */
export class UpdateChecker {
  private readonly currentVersion: string | null;
  private readonly enabled: boolean;
  private readonly fetchLatest: () => Promise<string>;
  private readonly now: () => number;
  private readonly successTtlMs: number;
  private readonly failureTtlMs: number;

  private cache: CacheEntry | null = null;
  private inFlight: Promise<CacheEntry> | null = null;

  constructor(opts: UpdateCheckerOptions) {
    this.currentVersion = opts.currentVersion;
    this.enabled = opts.enabled;
    this.fetchLatest = opts.fetchLatest ?? fetchLatestReleaseVersion;
    this.now = opts.now ?? Date.now;
    this.successTtlMs = opts.successTtlMs ?? SUCCESS_TTL_MS;
    this.failureTtlMs = opts.failureTtlMs ?? FAILURE_TTL_MS;
  }

  async getStatus(): Promise<UpdateStatus> {
    // Opt-out or unknown running version → never call out, report disabled.
    if (!this.enabled || !this.currentVersion) {
      return {
        check_enabled: false,
        update_available: false,
        latest_version: null,
        checked_at: null,
      };
    }

    const entry = await this.getCacheEntry();
    const latest = entry.latestVersion;
    return {
      check_enabled: true,
      update_available: latest !== null && isNewerVersion(this.currentVersion, latest),
      latest_version: latest,
      checked_at: entry.checkedAt > 0 ? new Date(entry.checkedAt).toISOString() : null,
    };
  }

  private async getCacheEntry(): Promise<CacheEntry> {
    if (this.cache && this.cache.expiresAt > this.now()) return this.cache;
    // Single-flight: concurrent callers during a refresh share one request.
    this.inFlight ??= this.refresh();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async refresh(): Promise<CacheEntry> {
    try {
      const latestVersion = await this.fetchLatest();
      const checkedAt = this.now();
      this.cache = { latestVersion, checkedAt, expiresAt: checkedAt + this.successTtlMs };
    } catch (err) {
      // Negative cache — keep the previous successful result visible (a
      // transient GitHub outage should not clear an already-known update),
      // but retry sooner than the success TTL.
      logger.warn("Update check failed — retrying later", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.cache = {
        latestVersion: this.cache?.latestVersion ?? null,
        checkedAt: this.cache?.checkedAt ?? 0,
        expiresAt: this.now() + this.failureTtlMs,
      };
    }
    return this.cache;
  }
}

let _checker: UpdateChecker | null = null;

/** Process-wide singleton, lazily built from env + the stamped build version. */
export function getUpdateChecker(): UpdateChecker {
  if (!_checker) {
    const env = getEnv();
    const running = getVersionInfo().app;
    _checker = new UpdateChecker({
      currentVersion: running === "dev" ? null : running,
      enabled: env.UPDATE_CHECK_ENABLED,
    });
  }
  return _checker;
}

/** Test hook — drop the singleton so env changes are picked up. */
export function _resetUpdateCheckerForTesting(): void {
  _checker = null;
}
