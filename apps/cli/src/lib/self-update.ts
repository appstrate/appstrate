// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers + injectable I/O for `appstrate self-update`.
 *
 * Split from `commands/self-update.ts` so tests can exercise the parsing,
 * resolution, and verification logic without touching the network or the
 * real filesystem. The command file wires `defaultSelfUpdateDeps` and
 * formats user-facing prompts; this module owns the algorithm.
 *
 * Channel handling (issue #249, phase 2):
 *   - `curl`: download release asset + signed checksums + minisign sig,
 *     verify, atomic-rename over `process.execPath`.
 *   - `bun`: refuse with `bun update -g appstrate` hint (npm owns the
 *     binary, our atomic-replace would desync npm metadata).
 *   - `unknown`: refuse with a diagnostic — we cannot prove what produced
 *     this binary, so we cannot prove the update target matches.
 */

import { mkdtemp, rename, rm, stat, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand, type CommandResult } from "./install/os.ts";
import { CLI_USER_AGENT, CLI_VERSION, DEV_CLI_VERSION } from "./version.ts";

/** Pubkey baked into the curl bootstrap (`scripts/bootstrap.sh`). Same key signs every release. */
export const APPSTRATE_MINISIGN_PUBKEY = "RWT6xCZCCP/yHolAgDuDqBssxUflw7gInlZlaXEfQ4cFi5XN0KCtKr0e";

const RELEASE_URL_BASE = "https://github.com/appstrate/appstrate/releases";
const LATEST_API_URL = "https://api.github.com/repos/appstrate/appstrate/releases/latest";

export type Platform = "darwin" | "linux";
export type Architecture = "x64" | "arm64";

export interface PlatformInfo {
  platform: Platform;
  arch: Architecture;
}

/**
 * Map Node `process.platform` / `process.arch` to the `appstrate-<os>-<arch>`
 * asset name format used by the release matrix in `.github/workflows/release.yml`.
 *
 * Throws on unsupported combinations — we only ship 4 binaries
 * (darwin/x64, darwin/arm64, linux/x64, linux/arm64). Anything else
 * (Windows, freebsd, mips, …) means `self-update` cannot help and the
 * user has to follow whichever ad-hoc install path got them here.
 */
export function detectPlatform(
  raw: { platform: NodeJS.Platform; arch: string } = {
    platform: process.platform,
    arch: process.arch,
  },
): PlatformInfo {
  let platform: Platform;
  if (raw.platform === "darwin") platform = "darwin";
  else if (raw.platform === "linux") platform = "linux";
  else {
    throw new Error(
      `self-update is only supported on macOS and Linux (detected: ${raw.platform}).`,
    );
  }

  let arch: Architecture;
  if (raw.arch === "x64") arch = "x64";
  else if (raw.arch === "arm64") arch = "arm64";
  else {
    throw new Error(`self-update is only supported on x64 and arm64 (detected: ${raw.arch}).`);
  }

  return { platform, arch };
}

export function assetName(info: PlatformInfo): string {
  return `appstrate-${info.platform}-${info.arch}`;
}

export interface ReleaseUrls {
  binary: string;
  checksums: string;
  checksumsSig: string;
}

/**
 * Resolve the three URLs needed to install a given version of the CLI.
 * Mirrors `scripts/bootstrap.sh` — keep them in lockstep so the install
 * UX is identical whether the user is bootstrapping or self-updating.
 */
export function releaseUrls(version: string, info: PlatformInfo): ReleaseUrls {
  const base =
    version === "latest"
      ? `${RELEASE_URL_BASE}/latest/download`
      : `${RELEASE_URL_BASE}/download/v${version.replace(/^v/, "")}`;
  const asset = assetName(info);
  return {
    binary: `${base}/${asset}`,
    checksums: `${base}/checksums.txt`,
    checksumsSig: `${base}/checksums.txt.minisig`,
  };
}

/**
 * Parse a `checksums.txt` line for the given asset and return its hex SHA-256.
 *
 * Same defensive validation as bootstrap.sh: the asset MUST be listed exactly
 * once. Missing → tampering or broken release. Duplicated → could mask a
 * mismatch. Hash format must be 64 hex chars (SHA-256). Anything else is rejected.
 */
export function parseChecksumLine(content: string, asset: string): string {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // Each line is `<hex>  <filename>` (sha256sum format) or `<hex> *<filename>` (binary mode).
  const matches = lines.filter((line) => {
    const parts = line.split(/\s+/);
    if (parts.length !== 2) return false;
    const file = (parts[1] ?? "").replace(/^\*/, "");
    return file === asset;
  });
  if (matches.length === 0) {
    throw new Error(
      `Asset ${asset} is not listed in the signed checksums manifest. ` +
        `This is either a broken release or tampering — refusing to install. ` +
        `Report at https://github.com/appstrate/appstrate/issues`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Expected exactly one line for ${asset} in checksums.txt, got ${matches.length}. ` +
        `Duplicate or malformed entries — refusing to install.`,
    );
  }
  const firstLine = matches[0]!;
  const hash = firstLine.split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(
      `Invalid SHA-256 in checksums.txt for ${asset}: "${hash}" is not 64 hex characters.`,
    );
  }
  return hash;
}

/**
 * Compare two semver-ish strings. Pure prefix-of-numeric-segments compare —
 * good enough for the "current vs target" check in `self-update`, which only
 * needs to know if they are equal. Pre-release suffixes (`1.0.0-alpha.5`)
 * compare lexicographically after the numeric prefix, matching npm.
 *
 * Returns -1 if `a < b`, 0 if equal, 1 if `a > b`.
 */
export function compareSemver(a: string, b: string): number {
  const split = (v: string): { numeric: [number, number, number]; pre: string } => {
    const trimmed = v.replace(/^v/, "");
    const [core, ...preParts] = trimmed.split("-");
    const segments = (core ?? "").split(".").map((s) => Number.parseInt(s, 10) || 0);
    return {
      numeric: [segments[0] ?? 0, segments[1] ?? 0, segments[2] ?? 0],
      pre: preParts.join("-"),
    };
  };
  const A = split(a);
  const B = split(b);
  for (let i = 0; i < 3; i++) {
    const ai = A.numeric[i]!;
    const bi = B.numeric[i]!;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  // Numeric-prefix tie. A pre-release is LOWER than a release (npm semver §11).
  if (A.pre === "" && B.pre === "") return 0;
  if (A.pre === "" && B.pre !== "") return 1;
  if (A.pre !== "" && B.pre === "") return -1;
  if (A.pre < B.pre) return -1;
  if (A.pre > B.pre) return 1;
  return 0;
}

/** Strip a leading `v` from a tag name. GitHub tags are `vX.Y.Z`; the CLI carries `X.Y.Z`. */
export function normalizeVersion(raw: string): string {
  return raw.replace(/^v/, "").trim();
}

export interface SelfUpdateDeps {
  /** GET a URL and return the body as bytes. Throws on HTTP error. */
  fetchBinary(url: string): Promise<Uint8Array>;
  /** GET a URL and return the body as text. */
  fetchText(url: string): Promise<string>;
  /** Compute hex SHA-256 of bytes. */
  sha256Hex(data: Uint8Array): Promise<string>;
  /** Run a subprocess; same shape as `runCommand`. */
  runCommand(cmd: string, args: string[]): Promise<CommandResult>;
  /** `process.execPath` — the running binary path that gets atomic-renamed over. */
  execPath(): string;
  /**
   * Atomically install `bytes` at `dest`. The default impl writes to a same-
   * directory temp file, chmods +x, and `rename(2)`s on top of `dest`. Tests
   * stub this entirely to avoid touching the real binary.
   */
  atomicReplace(bytes: Uint8Array, dest: string): Promise<void>;
  /** Working directory for downloaded artefacts (binary + checksums + sig). */
  makeWorkDir(): Promise<string>;
  /** Cleanup helper. */
  removeDir(path: string): Promise<void>;
  /** Write a file (used in the work dir for minisign input). */
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
}

export const defaultSelfUpdateDeps: SelfUpdateDeps = {
  async fetchBinary(url) {
    const res = await fetch(url, {
      headers: { "User-Agent": CLI_USER_AGENT },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
    return new Uint8Array(await res.arrayBuffer());
  },
  async fetchText(url) {
    const res = await fetch(url, {
      headers: { "User-Agent": CLI_USER_AGENT },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
    return res.text();
  },
  async sha256Hex(data) {
    // Bun.CryptoHasher is available in the bundled binary (Bun runtime baked in).
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(data);
    return hasher.digest("hex");
  },
  runCommand,
  execPath: () => process.execPath,
  async atomicReplace(bytes, dest) {
    // POSIX rename(2) on the same filesystem is atomic and works on the
    // running binary: the kernel detaches the inode but keeps the open fd
    // in this process valid. The temp file MUST live in the same dir as
    // dest (same fs by construction).
    const dir = dirname(dest);
    await mkdir(dir, { recursive: true });
    const stagedDir = await mkdtemp(`${dest}.staging.`);
    try {
      const staged = join(stagedDir, "appstrate.new");
      await writeFile(staged, bytes);
      await chmod(staged, 0o755);
      await rename(staged, dest);
    } finally {
      // Best-effort cleanup. If rename succeeded the staging dir is empty;
      // if it failed we still want the (possibly large) staged file gone.
      await rm(stagedDir, { recursive: true, force: true }).catch(() => {});
    }
  },
  makeWorkDir() {
    return mkdtemp(join(tmpdir(), "appstrate-self-update-"));
  },
  removeDir(path) {
    return rm(path, { recursive: true, force: true });
  },
  writeFile(path, data) {
    return writeFile(path, data);
  },
};

// Re-exported only for test introspection — production callers shouldn't need it.
export const _internals = { stat };

export interface ResolveTargetVersionDeps {
  fetchText(url: string): Promise<string>;
}

/**
 * Resolve the tag name to install. Defaults to `latest` (queries the GitHub
 * Releases API), but accepts an explicit version (`1.2.3` or `v1.2.3`).
 *
 * The API call is cheap (one GET) and avoids the GitHub-issued redirect chain
 * on `releases/latest/download/<asset>` which otherwise costs three round-trips
 * per file (binary + checksums + sig = 9 redirects).
 */
export async function resolveTargetVersion(
  requested: string | undefined,
  deps: ResolveTargetVersionDeps,
): Promise<string> {
  if (requested) {
    const v = normalizeVersion(requested);
    if (!/^\d+\.\d+\.\d+/.test(v)) {
      throw new Error(`Invalid version: "${requested}". Expected semver like 1.2.3 or v1.2.3.`);
    }
    return v;
  }
  const body = await deps.fetchText(LATEST_API_URL);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`GitHub Releases API returned non-JSON; cannot determine latest version.`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { tag_name?: unknown }).tag_name !== "string"
  ) {
    throw new Error(`GitHub Releases API response missing tag_name.`);
  }
  return normalizeVersion((parsed as { tag_name: string }).tag_name);
}

export interface PerformCurlUpdateOptions {
  /** Resolved tag name without the `v` prefix, e.g. `1.2.3`. */
  targetVersion: string;
  /** Detected platform (also used for the asset name). */
  platform: PlatformInfo;
  /** When true, skip the equality check that returns "already up to date". */
  force: boolean;
  /** Current CLI version (defaults to bundled `CLI_VERSION`). */
  currentVersion?: string;
  /** Override deps for tests. */
  deps?: SelfUpdateDeps;
  /** Logger sink — defaults to `console.error` so tests can collect output. */
  log?: (line: string) => void;
}

export interface PerformCurlUpdateResult {
  /** `"updated"` when a binary was written; `"already-up-to-date"` when no-op. */
  status: "updated" | "already-up-to-date";
  /** Final installed version. */
  version: string;
  /** Destination path that was atomic-replaced (only when status === "updated"). */
  destination?: string;
}

/**
 * Curl-channel update implementation. Throws on any verification failure —
 * the binary is never written unless minisign + SHA-256 both pass.
 */
export async function performCurlUpdate(
  opts: PerformCurlUpdateOptions,
): Promise<PerformCurlUpdateResult> {
  const deps = opts.deps ?? defaultSelfUpdateDeps;
  const log = opts.log ?? ((l) => console.error(l));
  const current = opts.currentVersion ?? CLI_VERSION;
  const target = opts.targetVersion;

  if (current === DEV_CLI_VERSION) {
    throw new Error(
      `Cannot self-update a dev build (CLI_VERSION="${DEV_CLI_VERSION}"). ` +
        `This binary was built from source, not from a release artefact. ` +
        `Reinstall via curl -fsSL https://get.appstrate.dev | bash to switch to a release.`,
    );
  }

  if (!opts.force && compareSemver(current, target) === 0) {
    return { status: "already-up-to-date", version: current };
  }

  // Require minisign on PATH. Same UX as bootstrap.sh — fail closed; a
  // signed-checksum check we can't perform is no check at all. The user
  // already has a working `appstrate` binary; nothing breaks if we don't
  // upgrade today.
  const minisignProbe = await deps.runCommand("minisign", ["-v"]);
  if (!minisignProbe.ok && minisignProbe.exitCode === -1) {
    // `runCommand` returns exitCode -1 for ENOENT (cmd not found).
    throw new Error(
      [
        "minisign is required to verify the Appstrate CLI update.",
        "  → macOS:   brew install minisign",
        "  → Debian:  sudo apt install minisign",
        "  → Alpine:  apk add minisign",
        "  → Other:   https://jedisct1.github.io/minisign/",
      ].join("\n"),
    );
  }

  const dest = deps.execPath();
  const workDir = await deps.makeWorkDir();
  try {
    const urls = releaseUrls(target, opts.platform);
    const asset = assetName(opts.platform);

    log(`→ Downloading Appstrate CLI ${target} (${asset})`);
    const [binary, checksumsTxt, checksumsSig] = await Promise.all([
      deps.fetchBinary(urls.binary),
      deps.fetchText(urls.checksums),
      deps.fetchBinary(urls.checksumsSig),
    ]);

    const sumsPath = join(workDir, "checksums.txt");
    const sigPath = join(workDir, "checksums.txt.minisig");
    await deps.writeFile(sumsPath, checksumsTxt);
    await deps.writeFile(sigPath, checksumsSig);

    log(`→ Verifying signature against Appstrate release key`);
    const sigCheck = await deps.runCommand("minisign", [
      "-Vm",
      sumsPath,
      "-P",
      APPSTRATE_MINISIGN_PUBKEY,
    ]);
    if (!sigCheck.ok) {
      throw new Error(
        `Signature verification FAILED. ` +
          `The checksums manifest was NOT signed by the Appstrate key. ` +
          `Refusing to install. Report at https://github.com/appstrate/appstrate/issues`,
      );
    }

    log(`→ Verifying binary integrity (SHA-256)`);
    const expected = parseChecksumLine(checksumsTxt, asset);
    const actual = await deps.sha256Hex(binary);
    if (actual !== expected) {
      throw new Error(
        `SHA-256 mismatch for ${asset}: expected ${expected}, got ${actual}. ` +
          `The downloaded binary does NOT match the signed manifest. ` +
          `This strongly suggests tampering — refusing to install.`,
      );
    }

    log(`→ Installing ${asset} → ${dest}`);
    await deps.atomicReplace(binary, dest);

    return { status: "updated", version: target, destination: dest };
  } finally {
    await deps.removeDir(workDir).catch(() => {});
  }
}
