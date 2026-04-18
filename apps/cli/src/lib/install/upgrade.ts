// SPDX-License-Identifier: Apache-2.0

/**
 * Upgrade + rollback primitives for `appstrate install`.
 *
 * Background: the first cut of the new CLI-driven install (ADR-006)
 * unconditionally overwrote `.env` + `docker-compose.yml`. Re-running
 * `appstrate install` on an existing deployment therefore rotated
 * BETTER_AUTH_SECRET (which invalidates every logged-in session) and —
 * more dangerously — rotated CONNECTION_ENCRYPTION_KEY, which makes
 * every stored OAuth credential in the DB unreadable. The old
 * `install.sh` had `determine_install_mode` + `merge_env` +
 * `rollback_upgrade` to guard against this; this module brings that
 * behaviour back to the TypeScript implementation.
 *
 * Contract:
 *   1. `detectInstallMode` looks for `<dir>/.env` and
 *      `<dir>/docker-compose.yml`. Either → `"upgrade"`; neither →
 *      `"fresh"`. The `.env` content (if present) is parsed and
 *      returned so the caller can merge-preserve existing secrets.
 *   2. `mergeEnv(existing, fresh)` gives precedence to the existing
 *      values. That is *critical*: re-generating secrets breaks
 *      sessions (BETTER_AUTH_SECRET) AND destroys in-flight data
 *      (CONNECTION_ENCRYPTION_KEY decrypts the `provider_credentials`
 *      table — rotate it and every stored OAuth token is bricked).
 *      New keys introduced by a tier upgrade (e.g. tier 1 → tier 3
 *      adds MINIO_ROOT_PASSWORD) are carried over from `fresh`.
 *   3. `backupFiles` + `restoreBackups` wrap an atomic-ish
 *      backup/restore around the write. On any downstream failure
 *      (docker compose up, healthcheck timeout, user Ctrl-C) the
 *      caller restores so the user is never left with a half-written
 *      config that won't boot with either the old OR the new stack.
 *
 * Non-goals: this module does NOT try to run `docker compose up`
 * against the restored config. The user's stack was already running
 * before we started; rolling back the files is enough to let them run
 * `docker compose up -d` themselves from `<dir>`. Attempting an
 * automatic restart would just add failure modes where we can't
 * usefully diagnose.
 */

import { stat, readFile, copyFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { EnvVars } from "./secrets.ts";

export type InstallMode = "fresh" | "upgrade";

export interface ExistingInstall {
  /** `<dir>/.env` exists on disk. */
  hasEnv: boolean;
  /** `<dir>/docker-compose.yml` exists on disk. */
  hasCompose: boolean;
  /** Parsed env vars from `<dir>/.env`; empty when `hasEnv` is false. */
  existingEnv: EnvVars;
}

export interface InstallModeResult {
  mode: InstallMode;
  existing: ExistingInstall;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Inspect `dir` to decide whether this invocation is a fresh install
 * or an upgrade. An upgrade is any dir that already contains an
 * Appstrate-looking artifact (`.env` or `docker-compose.yml`) —
 * partial states (only one of the two) also count as upgrades so we
 * don't silently obliterate a half-installed deployment.
 */
export async function detectInstallMode(dir: string): Promise<InstallModeResult> {
  const envPath = join(dir, ".env");
  const composePath = join(dir, "docker-compose.yml");
  const [hasEnv, hasCompose] = await Promise.all([fileExists(envPath), fileExists(composePath)]);

  let existingEnv: EnvVars = {};
  if (hasEnv) {
    try {
      existingEnv = parseEnvFile(await readFile(envPath, "utf8"));
    } catch {
      // A `.env` that exists but can't be read is treated as
      // `existingEnv = {}` so the caller falls back to fresh secrets
      // for every key. The file is still backed up before overwrite.
      existingEnv = {};
    }
  }

  const mode: InstallMode = hasEnv || hasCompose ? "upgrade" : "fresh";
  return { mode, existing: { hasEnv, hasCompose, existingEnv } };
}

/**
 * Parse a `.env` file body into a flat dict.
 *
 * Respects the subset of dotenv syntax the CLI itself emits in
 * `renderEnvFile`:
 *   - `# ...` lines ignored
 *   - blank lines ignored
 *   - `KEY=VALUE` lines (value is everything after the first `=`)
 *   - surrounding single or double quotes on VALUE stripped
 *
 * We intentionally do NOT implement `$VAR` interpolation, line
 * continuations, or `export KEY=VALUE` — none of those appear in the
 * files we write, and silently supporting them would risk recovering a
 * value that means something different to the consumer (e.g. bun
 * auto-loads `.env` but doesn't interpolate, so a user who added
 * `PASSWORD=$SECRET` to their file expects the literal string).
 */
export function parseEnvFile(body: string): EnvVars {
  const out: EnvVars = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue; // no key before `=`, or line is `=foo`
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue; // ignore garbage keys
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    out[key] = value;
  }
  return out;
}

/**
 * Keys whose `fresh` value must ALWAYS override `existing` — the opposite
 * of the default "existing wins" semantics. These are lockstep knobs,
 * not secrets: preserving an old value across re-installs would defeat
 * the invariant the CLI enforces.
 *
 *   - APPSTRATE_VERSION: ADR-006 §Lockstep versioning. The Docker image
 *     tag must track the CLI that orchestrates it; otherwise a `bun
 *     upgrade` of the CLI leaves the install pointing at stale images.
 */
const OVERRIDE_KEYS: readonly string[] = ["APPSTRATE_VERSION"];

/**
 * Merge an existing `.env` dict with a freshly-generated one, giving
 * precedence to the existing values EXCEPT for a small set of keys
 * (`OVERRIDE_KEYS`) that must track the current CLI.
 *
 * Why existing wins (by default):
 *   - BETTER_AUTH_SECRET: rotating invalidates every cookie session.
 *   - CONNECTION_ENCRYPTION_KEY: rotating bricks every encrypted
 *     credential row in `provider_credentials` (AES-256-GCM auth tag
 *     check fails, tokens can't be decrypted, org is locked out of
 *     every connected service).
 *   - RUN_TOKEN_SECRET / UPLOAD_SIGNING_SECRET: rotating invalidates
 *     pending runs + signed upload URLs.
 *   - POSTGRES_PASSWORD / MINIO_ROOT_PASSWORD: rotating requires a
 *     matching change on the server side too, which is out of scope
 *     for a re-run of `appstrate install`.
 *
 * Keys in `fresh` but not in `existing` are carried over (that's how
 * a tier-1 → tier-3 upgrade picks up the new MINIO_* entries). Keys
 * in `existing` but not in `fresh` are also preserved (user additions
 * like SMTP_HOST stay intact).
 */
export function mergeEnv(existing: EnvVars, fresh: EnvVars): EnvVars {
  const merged: EnvVars = { ...fresh, ...existing };
  for (const key of OVERRIDE_KEYS) {
    if (key in fresh) merged[key] = fresh[key] as string;
  }
  return merged;
}

/**
 * Copy each of `files` (relative to `dir`, skipping any that don't
 * exist) to `<name>.backup` in the same dir. Returns the list of
 * basenames that were actually backed up — the caller passes this to
 * `restoreBackups` / `cleanupBackups`.
 *
 * A single `.backup` suffix (no timestamp) is deliberate: we only
 * keep ONE previous generation. Timestamped backups accumulate forever
 * and turn the install dir into a graveyard; the user has `git` or
 * their own backup story if they want deeper history.
 */
export async function backupFiles(dir: string, files: string[]): Promise<string[]> {
  const backedUp: string[] = [];
  for (const name of files) {
    const src = join(dir, name);
    if (!(await fileExists(src))) continue;
    const dst = join(dir, `${name}.backup`);
    await copyFile(src, dst);
    backedUp.push(name);
  }
  return backedUp;
}

/**
 * Restore each `<dir>/<name>` from `<dir>/<name>.backup`. The backup
 * file is preserved after restore — that's belt-and-braces in case
 * the restore itself is interrupted; a second call to this function
 * would still work.
 *
 * Throws on any single failure. Callers should treat the whole restore
 * as best-effort and surface the error so the user can investigate.
 */
export async function restoreBackups(dir: string, backedUp: string[]): Promise<void> {
  for (const name of backedUp) {
    const backup = join(dir, `${name}.backup`);
    const target = join(dir, name);
    await copyFile(backup, target);
  }
}

/**
 * Delete the `.backup` files produced by `backupFiles` after a
 * successful upgrade. Silently swallows missing-file errors — the
 * goal is to leave a clean dir, not to double-check our own state.
 */
export async function cleanupBackups(dir: string, backedUp: string[]): Promise<void> {
  for (const name of backedUp) {
    const backup = join(dir, `${name}.backup`);
    await unlink(backup).catch(() => {});
  }
}

/**
 * Convenience: atomically replace `<dir>/<name>` by writing to a
 * sibling `.tmp` file and renaming. Used for the `.env` + compose
 * writes so a crashed/killed process can never leave a half-written
 * file behind — the rename is atomic on every filesystem we target.
 *
 * Kept here (next to the backup helpers) rather than in `tier123.ts`
 * because the atomicity guarantee is an upgrade-safety feature, not
 * a tier-specific concern.
 */
export async function atomicReplace(path: string, body: string, mode?: number): Promise<void> {
  const tmp = `${path}.tmp`;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(tmp, body, mode !== undefined ? { mode } : undefined);
  await rename(tmp, path);
}

/**
 * Wrap an upgrade step with rollback-on-failure semantics.
 *
 * Contract:
 *   - Calls `step`. If it resolves, calls `onSuccess` (e.g. cleanup
 *     backups) and returns the step's value.
 *   - If `step` rejects AND `backedUp` is non-empty, restores the
 *     backup files BEFORE re-throwing. The rethrown error message is
 *     augmented to explain what happened; a restore failure is
 *     surfaced separately so the user can escalate.
 *   - If `backedUp` is empty (fresh install), the error propagates
 *     unchanged — there's nothing to restore.
 *
 * Extracted from `commands/install.ts::installDockerTier` so the
 * rollback contract can be unit-tested without having to mock docker,
 * healthchecks, project-file sidecars, etc. The regression it guards
 * against: someone removes the `try/catch → restoreBackups` block and
 * the full-path integration test passes on the happy path while
 * silently losing its rollback-on-failure coverage.
 */
export async function runWithRollback<T>(
  dir: string,
  backedUp: string[],
  step: () => Promise<T>,
  onSuccess?: () => Promise<void>,
): Promise<T> {
  try {
    const result = await step();
    if (onSuccess) await onSuccess();
    return result;
  } catch (err) {
    if (backedUp.length === 0) throw err;
    try {
      await restoreBackups(dir, backedUp);
    } catch (restoreErr) {
      const originalMsg = err instanceof Error ? err.message : String(err);
      const restoreMsg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
      throw new Error(
        `Upgrade failed (${originalMsg}). Rollback also failed (${restoreMsg}); ` +
          `.backup files are preserved in ${dir} for manual recovery.`,
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Upgrade failed (${msg}). Original files restored from backup; ` +
        `run \`docker compose up -d\` in ${dir} to resume on the previous config.`,
    );
  }
}
