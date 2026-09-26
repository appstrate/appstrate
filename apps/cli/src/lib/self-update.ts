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
 *   - `curl`: resolve the target (a `--release` pin, else the tag named by the
 *     minisign-signed channel manifest), download release asset + signed
 *     checksums + minisign sig, verify, atomic-rename over `process.execPath`.
 *   - `bun`: refuse with `bun update -g appstrate` hint (npm owns the
 *     binary, our atomic-replace would desync npm metadata).
 *   - `unknown`: refuse with a diagnostic — we cannot prove what produced
 *     this binary, so we cannot prove the update target matches.
 */

import { mkdtemp, rename, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand, type CommandResult } from "./install/os.ts";
import { CLI_USER_AGENT, CLI_VERSION, DEV_CLI_VERSION } from "./version.ts";
import { streamDownload, type ProgressFn } from "./download.ts";
import { DEFAULT_IO } from "./io.ts";
import { normalizeVersion, stripVersionPrefix } from "@appstrate/core/semver";

// Re-exported so `normalizeVersion` stays importable from this module (its
// historical public surface); the canonical `v`/build-stripping implementation
// now lives in `@appstrate/core/semver`.
export { normalizeVersion };

/** Pubkey baked into the curl bootstrap (`scripts/bootstrap.sh`). Same key signs every release. */
export const APPSTRATE_MINISIGN_PUBKEY = "RWT6xCZCCP/yHolAgDuDqBssxUflw7gInlZlaXEfQ4cFi5XN0KCtKr0e";

const RELEASE_URL_BASE = "https://github.com/appstrate/appstrate/releases";
/**
 * The signed channel manifest naming the newest platform release
 * (`{ schema: 1, channel: "latest", tag: "v<semver>" }`), published by
 * `publish-installer.yml` next to the installer and signed with the release
 * key. It replaces any GitHub API lookup: it is not rate limited, and only the
 * workflow holding the key can move it — a `cli@`/`core@` Release, or one
 * created by hand, cannot steer an update.
 */
const CHANNEL_MANIFEST_URL = "https://get.appstrate.dev/channels/latest.json";
const CHANNEL_TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9._]+)?$/;

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

interface ReleaseUrls {
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
  // Always a pinned tag: `resolveTargetVersion` turns "latest" into the tag the
  // signed channel manifest names first, so `releases/latest/download` is never built.
  const base = `${RELEASE_URL_BASE}/download/v${stripVersionPrefix(version)}`;
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
 * Compare two semver strings per SemVer 2.0 §11.
 *
 * Returns -1 if `a < b`, 0 if equal, 1 if `a > b`. Used by `self-update`
 * to detect "already on target version" (equality check), but the full
 * ordering is implemented so callers can also gate downgrade refusal etc.
 *
 * Pre-release identifier rules (§11.4):
 *   - A version with a pre-release is LOWER than the same version without one.
 *   - Identifiers are compared dot-separated, left to right.
 *   - Numeric identifiers compare numerically; alphanumeric compare in ASCII;
 *     numeric identifiers always rank lower than alphanumeric. So
 *     `1.0.0-alpha.10` > `1.0.0-alpha.2` (correct), unlike a pure
 *     lexicographic compare which gets it wrong.
 *
 * Build metadata (`+...`) is stripped per §10 ("MUST be ignored when
 * determining version precedence").
 */
export function compareSemver(a: string, b: string): number {
  const split = (v: string): { numeric: [number, number, number]; pre: string[] } => {
    // Strip the `v` prefix and drop build metadata (§10) via the canonical
    // normalizer so precedence is computed on the same shape everywhere.
    const trimmed = normalizeVersion(v);
    const [core, ...preParts] = trimmed.split("-");
    const segments = (core ?? "").split(".").map((s) => Number.parseInt(s, 10) || 0);
    const preJoined = preParts.join("-");
    return {
      numeric: [segments[0] ?? 0, segments[1] ?? 0, segments[2] ?? 0],
      pre: preJoined === "" ? [] : preJoined.split("."),
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
  // §11.3: a version without pre-release ranks HIGHER than one with.
  if (A.pre.length === 0 && B.pre.length === 0) return 0;
  if (A.pre.length === 0) return 1;
  if (B.pre.length === 0) return -1;
  // §11.4: identifier-by-identifier compare.
  const len = Math.min(A.pre.length, B.pre.length);
  const numericRe = /^[0-9]+$/;
  for (let i = 0; i < len; i++) {
    const ai = A.pre[i]!;
    const bi = B.pre[i]!;
    const aNum = numericRe.test(ai);
    const bNum = numericRe.test(bi);
    if (aNum && bNum) {
      const an = Number.parseInt(ai, 10);
      const bn = Number.parseInt(bi, 10);
      if (an < bn) return -1;
      if (an > bn) return 1;
    } else if (aNum) {
      // §11.4.3: numeric identifiers have lower precedence than alphanumeric.
      return -1;
    } else if (bNum) {
      return 1;
    } else {
      if (ai < bi) return -1;
      if (ai > bi) return 1;
    }
  }
  // §11.4.4: a longer set of identifiers (when prefixes are equal) ranks higher.
  if (A.pre.length < B.pre.length) return -1;
  if (A.pre.length > B.pre.length) return 1;
  return 0;
}

/** I/O needed to download a small minisign-signed text artefact and verify it. */
export interface ReleaseChannelDeps {
  /** GET a URL and return the body as bytes (small artefacts: the minisig). */
  fetchBinary(url: string): Promise<Uint8Array>;
  /** GET a URL and return the body as text (checksums.txt, the channel manifest). */
  fetchText(url: string): Promise<string>;
  /** Run a subprocess; same shape as `runCommand`. */
  runCommand(cmd: string, args: string[]): Promise<CommandResult>;
  /** Write a file (used in the work dir for minisign input). */
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  /** Working directory for downloaded artefacts (signed file + sig). */
  makeWorkDir(): Promise<string>;
  /** Best-effort `rm -rf` — cleans the work dir and the staged download. */
  removeDir(path: string): Promise<void>;
}

export interface SelfUpdateDeps extends ReleaseChannelDeps {
  /**
   * Stream a URL to `dest` on disk and return its on-the-fly SHA-256. Used for
   * the large CLI binary — progress ticks feed a spinner, and a stalled
   * download aborts instead of hanging forever. Throws on HTTP error.
   */
  fetchToFile(url: string, dest: string, onProgress?: ProgressFn): Promise<{ sha256: string }>;
  /** `process.execPath` — the running binary path that gets atomic-renamed over. */
  execPath(): string;
  /**
   * Atomically promote an already-downloaded staged file onto `dest`: chmod +x
   * then `rename(2)` on top. The staged file MUST already live in `dest`'s
   * directory (same filesystem) so the rename is atomic and works over the
   * running binary. Tests stub this to avoid touching the real binary.
   */
  promoteFile(staged: string, dest: string): Promise<void>;
}

export const defaultSelfUpdateDeps: SelfUpdateDeps = {
  fetchToFile(url, dest, onProgress) {
    return streamDownload(url, dest, {
      headers: { "User-Agent": CLI_USER_AGENT },
      onProgress,
    });
  },
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
  runCommand,
  execPath: () => process.execPath,
  async promoteFile(staged, dest) {
    // POSIX rename(2) on the same filesystem is atomic and works on the
    // running binary: the kernel detaches the inode but keeps the open fd
    // in this process valid. `staged` is created same-dir as `dest` by the
    // caller (streamed there), so the rename never crosses a filesystem.
    await chmod(staged, 0o755);
    await rename(staged, dest);
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

/**
 * Download a small text artefact and its detached minisign signature into
 * `workDir`, verify them against the pinned Appstrate release key, and return
 * the text. The content is only handed back once the signature holds, so no
 * caller can parse bytes the release key did not sign.
 *
 * Fails closed when minisign is absent — same UX as bootstrap.sh: a signed
 * check we cannot perform is no check at all. The probe runs before any
 * download, so a host without minisign fails without touching the network.
 * `subject` names the artefact in both failure messages.
 */
export async function fetchSignedText(
  deps: ReleaseChannelDeps,
  opts: { url: string; sigUrl: string; workDir: string; subject: string },
): Promise<string> {
  const probe = await deps.runCommand("minisign", ["-v"]);
  if (!probe.ok && probe.exitCode === -1) {
    // `runCommand` returns exitCode -1 for ENOENT (cmd not found).
    throw new Error(
      [
        `minisign is required to verify ${opts.subject}.`,
        "  → macOS:   brew install minisign",
        "  → Debian:  sudo apt install minisign",
        "  → Alpine:  apk add minisign",
        "  → RHEL:    dnf install minisign",
        "  → Other:   https://jedisct1.github.io/minisign/",
      ].join("\n"),
    );
  }

  const [text, sig] = await Promise.all([deps.fetchText(opts.url), deps.fetchBinary(opts.sigUrl)]);
  const filePath = join(opts.workDir, opts.url.slice(opts.url.lastIndexOf("/") + 1));
  const sigPath = `${filePath}.minisig`;
  await deps.writeFile(filePath, text);
  await deps.writeFile(sigPath, sig);
  const check = await deps.runCommand("minisign", [
    "-V",
    "-m",
    filePath,
    "-x",
    sigPath,
    "-P",
    APPSTRATE_MINISIGN_PUBKEY,
  ]);
  if (!check.ok) {
    throw new Error(
      `Signature verification FAILED: ${opts.subject} was NOT signed by the Appstrate ` +
        `release key. Refusing to continue (broken release or tampering). ` +
        `Report at https://github.com/appstrate/appstrate/issues`,
    );
  }
  return text;
}

/**
 * The newest platform release, as named by the signed channel manifest
 * ({@link CHANNEL_MANIFEST_URL}), without the `v` prefix. The signature is
 * verified BEFORE the body is parsed, then the manifest must be exactly the
 * published contract. Every failure throws; callers append the pin escape
 * hatch that fits their command.
 */
export async function resolveLatestRelease(deps: ReleaseChannelDeps): Promise<string> {
  const workDir = await deps.makeWorkDir();
  let body: string;
  try {
    body = await fetchSignedText(deps, {
      url: CHANNEL_MANIFEST_URL,
      sigUrl: `${CHANNEL_MANIFEST_URL}.minisig`,
      workDir,
      subject: "the release channel manifest",
    });
  } finally {
    await deps.removeDir(workDir).catch(() => {});
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(body);
  } catch {
    throw new Error(`The channel manifest ${CHANNEL_MANIFEST_URL} is not valid JSON.`);
  }
  const { schema, channel, tag } = (manifest ?? {}) as {
    schema?: unknown;
    channel?: unknown;
    tag?: unknown;
  };
  if (schema !== 1) {
    throw new Error(`Unsupported channel manifest schema ${JSON.stringify(schema)} (expected 1).`);
  }
  if (channel !== "latest") {
    throw new Error(
      `The channel manifest is for channel ${JSON.stringify(channel)}, not "latest".`,
    );
  }
  if (typeof tag !== "string" || !CHANNEL_TAG.test(tag)) {
    throw new Error(
      `The channel manifest names ${JSON.stringify(tag)}, not a platform v<semver> release tag.`,
    );
  }
  return normalizeVersion(tag);
}

/**
 * Resolve the version to install, without the `v` prefix. An explicit version
 * (`1.2.3` or `v1.2.3`) is validated and returned without any network call;
 * otherwise the signed channel manifest names the newest release.
 */
export async function resolveTargetVersion(
  requested: string | undefined,
  deps: ReleaseChannelDeps,
): Promise<string> {
  if (requested) {
    const v = normalizeVersion(requested);
    // Anchored at BOTH ends: `v` is interpolated straight into the release
    // download URL (`releaseUrls`), so an unanchored match would let a value
    // like `1.2.3/../../evil` or `1.2.3 rm -rf` through and steer the URL.
    // Allow an optional semver prerelease/build suffix (e.g. `1.2.3-beta.1`).
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v)) {
      throw new Error(`Invalid version: "${requested}". Expected semver like 1.2.3 or v1.2.3.`);
    }
    return v;
  }
  try {
    return await resolveLatestRelease(deps);
  } catch (err) {
    throw new Error(
      `${(err as Error).message}\n` +
        `Pin a release with --release X.Y.Z to skip the channel manifest (${CHANNEL_MANIFEST_URL}).`,
      { cause: err },
    );
  }
}

interface PerformCurlUpdateOptions {
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
  /**
   * Progress-line sink. Defaults to the CLI's stderr seam (`DEFAULT_IO`), the
   * same channel every other command reports on; tests pass their own
   * collector. Never `console.*` — the repo routes all CLI output through
   * `CommandIO` (`lib/io.ts`) so nothing writes to a global stream by name.
   */
  log?: (line: string) => void;
  /** Download-progress sink for the CLI binary (bytes/percent/rate). */
  onProgress?: ProgressFn;
}

export interface PerformCurlUpdateResult {
  /**
   * `"updated"` when a binary was written; `"already-up-to-date"` when the
   * target equals the running version; `"refused-downgrade"` when the target
   * is OLDER than it. Both no-op statuses leave the binary untouched.
   */
  status: "updated" | "already-up-to-date" | "refused-downgrade";
  /** Final installed version — the running one for both no-op statuses. */
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
  const log = opts.log ?? ((l: string) => DEFAULT_IO.stderr.write(`${l}\n`));
  const current = opts.currentVersion ?? CLI_VERSION;
  const target = opts.targetVersion;

  if (current === DEV_CLI_VERSION) {
    throw new Error(
      `Cannot self-update a dev build (CLI_VERSION="${DEV_CLI_VERSION}"). ` +
        `This binary was built from source, not from a release artefact. ` +
        `Reinstall via curl -fsSL https://get.appstrate.dev | bash to switch to a release.`,
    );
  }

  // Never move backwards. A target below the running version means either a
  // `--release` naming an older line or a channel manifest pointing back at one
  // (a rolled-back publish) — in both cases installing it strands the user on
  // the older binary, and the next run would resolve the same target and keep
  // them there. `--force` is the deliberate override.
  if (!opts.force) {
    const cmp = compareSemver(current, target);
    if (cmp === 0) return { status: "already-up-to-date", version: current };
    if (cmp > 0) return { status: "refused-downgrade", version: current };
  }

  const dest = deps.execPath();
  const workDir = await deps.makeWorkDir();
  // Stage the (large) binary in the SAME directory as `dest` so the final
  // promotion is an atomic same-filesystem rename over the running binary.
  // The small checksums + signature live in the throwaway work dir. Fixed
  // staged name (no pid suffix): a retry after a crash/SIGKILL overwrites the
  // previous partial file instead of accumulating hidden ~113 MB orphans;
  // the SHA-256 gate fails closed on interleaved writes.
  const staged = join(dirname(dest), ".appstrate.download");
  try {
    const urls = releaseUrls(target, opts.platform);
    const asset = assetName(opts.platform);

    // Fetch + verify the small signed manifest FIRST, before the large binary
    // stream. Two reasons: (1) it fails fast on a missing minisign or a bad
    // signature without pulling ~113 MB; (2) it avoids running the big stream
    // concurrently with the sidecars — a Promise.all reject would run cleanup
    // while the stream is still writing `staged`, leaving an orphan download.
    log(`→ Verifying signature against Appstrate release key`);
    const checksumsTxt = await fetchSignedText(deps, {
      url: urls.checksums,
      sigUrl: urls.checksumsSig,
      workDir,
      subject: "the release checksums manifest",
    });

    log(`→ Downloading Appstrate CLI ${target} (${asset})`);
    const { sha256: actual } = await deps.fetchToFile(urls.binary, staged, opts.onProgress);

    log(`→ Verifying binary integrity (SHA-256)`);
    const expected = parseChecksumLine(checksumsTxt, asset);
    if (actual !== expected) {
      throw new Error(
        `SHA-256 mismatch for ${asset}: expected ${expected}, got ${actual}. ` +
          `The downloaded binary does NOT match the signed manifest. ` +
          `This strongly suggests tampering — refusing to install.`,
      );
    }

    log(`→ Installing ${asset} → ${dest}`);
    await deps.promoteFile(staged, dest);

    return { status: "updated", version: target, destination: dest };
  } finally {
    // Remove the staged download if it survived (verification/promotion failed
    // before the rename consumed it), then the small-artefact work dir. Both
    // go through the same best-effort `rm -rf`.
    await deps.removeDir(staged).catch(() => {});
    await deps.removeDir(workDir).catch(() => {});
  }
}
