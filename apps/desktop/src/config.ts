// SPDX-License-Identifier: Apache-2.0

/**
 * Per-install config: profile-based multi-instance support.
 *
 * Stored in Electron's userData dir as `config.json` (one file, atomic
 * overwrite). Mirrors the CLI's `config.toml` shape so the two surfaces
 * stay conceptually symmetric:
 *
 *   {
 *     "defaultProfile": "local",
 *     "profiles": {
 *       "local":  { "instance": "http://localhost:3000" },
 *       "dev":    { "instance": "http://localhost:3001" },
 *       "cloud":  { "instance": "https://app.appstrate.com" }
 *     }
 *   }
 *
 * Auth state (Better Auth session cookies) lives in Chromium's session
 * store, scoped by host. Two profiles pointing at different hosts have
 * independent sessions automatically — we don't manage that.
 *
 * Legacy single-instance configs (`{ "instance": "..." }`) are migrated
 * transparently on first read.
 */

import { app } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

export interface ProfileConfig {
  /** Origin URL of the Appstrate instance (scheme + host, no trailing slash). */
  instance: string;
  /** ISO timestamp of the last time this profile was active. */
  lastUsedAt?: string;
}

export interface Config {
  /** Name of the profile loaded at app start. */
  defaultProfile: string;
  /** Named profiles keyed by user-facing label (`"local"`, `"prod"`, …). */
  profiles: Record<string, ProfileConfig>;
}

interface LegacyConfig {
  /** Pre-multi-instance shape: single instance URL at the top level. */
  instance: string;
}

function configPath(): string {
  return join(app.getPath("userData"), "config.json");
}

/**
 * Read the config file. Returns null if the file doesn't exist yet
 * (first launch). Transparently migrates the legacy single-instance
 * shape so existing installs don't lose their setup.
 */
export async function readConfigFile(): Promise<Config | null> {
  let raw: string;
  try {
    raw = await readFile(configPath(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as Config | LegacyConfig;
  // Legacy single-instance config — wrap into a default profile.
  if ("instance" in parsed && typeof parsed.instance === "string" && !("profiles" in parsed)) {
    const migrated: Config = {
      defaultProfile: "default",
      profiles: { default: { instance: parsed.instance } },
    };
    await writeConfigFile(migrated);
    return migrated;
  }
  if (typeof (parsed as Config).defaultProfile !== "string") return null;
  if (!(parsed as Config).profiles || typeof (parsed as Config).profiles !== "object") return null;
  return parsed as Config;
}

export async function writeConfigFile(cfg: Config): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/**
 * Resolve the instance URL of the currently-active profile. Returns
 * null if the config is missing or the named default profile isn't
 * declared (corrupted state).
 */
export function activeInstance(cfg: Config): string | null {
  const profile = cfg.profiles[cfg.defaultProfile];
  return profile?.instance ?? null;
}

/**
 * Bump `lastUsedAt` on the active profile. Fire-and-forget — losing
 * the write isn't catastrophic, it just means the "recent profiles"
 * sort order will lag by one launch.
 */
export async function touchActiveProfile(cfg: Config): Promise<void> {
  const profile = cfg.profiles[cfg.defaultProfile];
  if (!profile) return;
  profile.lastUsedAt = new Date().toISOString();
  await writeConfigFile(cfg);
}

/**
 * Add a new profile (or overwrite an existing one with the same name)
 * and switch to it. Returns the resulting config.
 */
export async function upsertAndSwitchProfile(name: string, instance: string): Promise<Config> {
  const existing = (await readConfigFile()) ?? { defaultProfile: name, profiles: {} };
  existing.profiles[name] = { instance, lastUsedAt: new Date().toISOString() };
  existing.defaultProfile = name;
  await writeConfigFile(existing);
  return existing;
}

/**
 * Switch the active profile to `name`. Throws if the profile doesn't
 * exist — callers must add it first via `upsertAndSwitchProfile`.
 */
export async function switchProfile(name: string): Promise<Config> {
  const cfg = await readConfigFile();
  if (!cfg) throw new Error("Config not initialized");
  if (!cfg.profiles[name]) throw new Error(`Unknown profile: ${name}`);
  cfg.defaultProfile = name;
  cfg.profiles[name].lastUsedAt = new Date().toISOString();
  await writeConfigFile(cfg);
  return cfg;
}

export function normalizeInstance(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  const url = new URL(trimmed);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Instance URL must use http(s): ${raw}`);
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * Derive a default profile label from an instance URL. `localhost:3000`
 * → `local-3000`, `app.appstrate.com` → `app.appstrate.com`. The user
 * can rename via the setup form, but a sensible suggestion saves
 * typing in the common case.
 */
export function suggestProfileName(instance: string): string {
  const url = new URL(instance);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return `local-${url.port || "default"}`;
  }
  return url.hostname;
}
