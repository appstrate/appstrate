// SPDX-License-Identifier: Apache-2.0

/**
 * Guest-artifact resolver for the `appstrate-runner` daemon (issue #819,
 * phase 2).
 *
 * Historically the daemon required an on-host `bun run firecracker:build`
 * — Docker + sudo + a full monorepo checkout, ~10 min and ~1.3 GB, on
 * every KVM host. This module replaces that with a download of versioned,
 * checksum-verified artifacts published as GitHub Release assets:
 *
 *   - `vmlinux-<arch>`              (guest kernel, uncompressed)
 *   - `rootfs-<arch>.ext4.zst`      (guest rootfs, zstd-compressed)
 *   - `firecracker-artifacts-manifest.json` (per release, all arches)
 *
 * At daemon boot (before the orchestrator's initialize()) the resolver
 * downloads the manifest + the two files for the current arch, verifies
 * their SHA256, decompresses the rootfs (zstd), and installs
 * both atomically (tmp write + rename) into the paths the engine reads
 * (FIRECRACKER_KERNEL_PATH / FIRECRACKER_ROOTFS_PATH). A version marker
 * records what is installed so subsequent boots skip the download.
 *
 * Failure policy:
 *   - artifacts already present + network/download failure → warn, keep
 *     what is on disk, continue booting.
 *   - artifacts missing + download failure → fatal, with an actionable
 *     message (build locally or set the env vars).
 *   - guest-protocol mismatch or checksum mismatch → ALWAYS fatal (a
 *     corrupt/tampered asset, or artifacts this daemon cannot run).
 *
 * Dev opt-out: `FIRECRACKER_ARTIFACTS_LOCAL=1` skips the resolver
 * entirely — the developer builds artifacts locally with
 * `bun run firecracker:build` and iterates on guest/ without a download.
 */

import { dirname, join } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import { getErrorMessage } from "@appstrate/core/errors";
import type { Logger } from "@appstrate/core/logger";
import { logger as defaultLogger } from "./logger.ts";

/**
 * Guest-artifact compatibility version. Couples the daemon engine (config
 * drive layout, exit-marker protocol, in-guest supervisor contract) to the
 * artifacts it can boot. The published manifest carries the same number;
 * the resolver refuses a mismatch (a newer/older artifact set the running
 * daemon cannot drive).
 *
 * BUMP RULES — increment when a change makes a NEW daemon unable to boot an
 * OLD artifact, or an OLD daemon unable to boot a NEW artifact, i.e. any
 * change to the host↔guest contract:
 *   - config-drive schema (guest-config.ts GuestConfig shape / field names)
 *   - exit-marker protocol (nonce framing, console markers)
 *   - kernel feature requirements the supervisor depends on (e.g. dropping
 *     or adding a required netfilter option)
 *   - rootfs layout the daemon assumes (init path, mount points, uids)
 * Do NOT bump for changes internal to the guest that stay wire-compatible
 * (a supervisor bugfix, a new optional field the daemon does not require).
 * A bump is a lockstep release: publish artifacts at protocol N together
 * with the daemon that speaks N.
 *
 * History:
 *   2 — MMDS credential broker (config-drive `credentials.source: "mmds"`
 *       strips RUN_TOKEN/APPSTRATE_SINK_SECRET off the drive; a protocol-1
 *       supervisor ignores the field, never fetches MMDS, and boots the
 *       run without credentials).
 *   1 — initial config-drive contract.
 */
export const GUEST_PROTOCOL_VERSION = 2;

/** GitHub Release download base for this repo (versioned + `latest`). */
export const DEFAULT_ARTIFACTS_BASE_URL = "https://github.com/appstrate/appstrate/releases";

/** Combined manifest asset name (one per release, all arches). */
export const MANIFEST_ASSET_NAME = "firecracker-artifacts-manifest.json";

/** Marker filename (installed alongside the rootfs). */
const VERSION_MARKER_NAME = ".firecracker-artifacts.json";

/** Supported guest architectures (matches the CI publication matrix). */
export type GuestArch = "x86_64" | "aarch64";

// ---------------------------------------------------------------------------
// Manifest schema (published as a GH Release asset — snake_case on the wire)
// ---------------------------------------------------------------------------

const artifactFileSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a 64-char lowercase hex sha256"),
  size: z.number().int().positive(),
});

const rootfsFileSchema = artifactFileSchema.extend({
  /** Size of the `.zst` asset that is downloaded (the on-disk file is `size`). */
  compressed_size: z.number().int().positive(),
});

const archArtifactsSchema = z.object({
  vmlinux: artifactFileSchema,
  rootfs: rootfsFileSchema,
});

export const artifactsManifestSchema = z.object({
  version: z.string().min(1),
  guest_protocol: z.number().int().positive(),
  artifacts: z.record(z.string(), archArtifactsSchema),
});

export type ArtifactsManifest = z.infer<typeof artifactsManifestSchema>;

// ---------------------------------------------------------------------------
// Public config + dependency injection surface
// ---------------------------------------------------------------------------

export interface ArtifactsConfig {
  /** FIRECRACKER_KERNEL_PATH — where the engine reads the guest kernel. */
  kernelPath: string;
  /** FIRECRACKER_ROOTFS_PATH — where the engine reads the guest rootfs. */
  rootfsPath: string;
  /** GH Release download base — defaults to {@link DEFAULT_ARTIFACTS_BASE_URL}. */
  baseUrl?: string;
  /** FIRECRACKER_ARTIFACTS_VERSION — pin a release (optional). */
  version?: string;
  /** FIRECRACKER_ARTIFACTS_LOCAL — skip the resolver entirely (dev). */
  local: boolean;
}

/**
 * Minimal filesystem surface the resolver depends on. Injected so unit
 * tests can drive install/skip logic with an in-memory fake (the repo
 * bans `mock.module()`), and so the atomic tmp-write-then-rename contract
 * is observable at the resolver level rather than hidden in an impl.
 */
export interface ArtifactsFs {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  mkdirp(dir: string): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface ArtifactsDeps {
  fetchFn?: typeof fetch;
  fs?: ArtifactsFs;
  logger?: Logger;
  /** zstd decompression (defaults to Bun's built-in — no external dep). */
  decompressZstd?: (bytes: Uint8Array) => Uint8Array;
  /** Guest arch (defaults to the running process arch). */
  arch?: GuestArch;
}

/**
 * Fatal even when artifacts are already present on disk — a mismatch the
 * "keep existing, warn" fallback must NOT swallow (protocol mismatch,
 * checksum mismatch, arch not published).
 */
export class FatalArtifactsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalArtifactsError";
  }
}

// ---------------------------------------------------------------------------
// Real Bun/node filesystem implementation
// ---------------------------------------------------------------------------

const bunFs: ArtifactsFs = {
  async exists(path) {
    return Bun.file(path).exists();
  },
  async readText(path) {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  },
  async writeText(path, text) {
    await writeFile(path, text, "utf8");
  },
  async mkdirp(dir) {
    await mkdir(dir, { recursive: true });
  },
  async writeBytes(path, bytes) {
    await writeFile(path, bytes);
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async remove(path) {
    await rm(path, { force: true });
  },
};

// ---------------------------------------------------------------------------
// Arch mapping
// ---------------------------------------------------------------------------

/** Map the Node/Bun `process.arch` to the CI publication arch label. */
export function resolveArch(nodeArch: string = process.arch): GuestArch {
  switch (nodeArch) {
    case "x64":
      return "x86_64";
    case "arm64":
      return "aarch64";
    default:
      throw new FatalArtifactsError(
        `unsupported architecture "${nodeArch}" — Firecracker guest artifacts are ` +
          `published for x86_64 (x64) and aarch64 (arm64) only`,
      );
  }
}

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

/**
 * Build the download URL for an asset. With a pinned `version` this points
 * at `<base>/download/v<version>/<asset>`; without one it uses GitHub's
 * `<base>/latest/download/<asset>` redirect to the newest release.
 */
function assetUrl(baseUrl: string, version: string | undefined, asset: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (version) {
    const tag = version.startsWith("v") ? version : `v${version}`;
    return `${base}/download/${tag}/${asset}`;
  }
  return `${base}/latest/download/${asset}`;
}

// ---------------------------------------------------------------------------
// Buffered download + hash
// ---------------------------------------------------------------------------

interface DownloadResult {
  bytes: Uint8Array;
  sha256: string;
}

/**
 * Fetch `url`, buffer the whole response, and return the bytes plus their
 * hex sha256 digest. The caller compares the digest against the manifest
 * before trusting the bytes.
 */
async function downloadHashed(fetchFn: typeof fetch, url: string): Promise<DownloadResult> {
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`GET ${url} → HTTP ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return { bytes, sha256 };
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Ensure the guest kernel + rootfs are present and match the requested
 * version. Called once at daemon boot, before orchestrator.initialize().
 */
export async function ensureGuestArtifacts(
  config: ArtifactsConfig,
  deps: ArtifactsDeps = {},
): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const fs = deps.fs ?? bunFs;
  const log = deps.logger ?? defaultLogger;
  const decompressZstd = deps.decompressZstd ?? ((bytes) => Bun.zstdDecompressSync(bytes));
  const arch = deps.arch ?? resolveArch();

  // Dev opt-out: the developer manages artifacts by hand.
  if (config.local) {
    log.info("Firecracker artifacts: FIRECRACKER_ARTIFACTS_LOCAL set — skipping download", {
      kernelPath: config.kernelPath,
      rootfsPath: config.rootfsPath,
    });
    return;
  }

  const present = (await fs.exists(config.kernelPath)) && (await fs.exists(config.rootfsPath));
  const markerPath = join(dirname(config.rootfsPath), VERSION_MARKER_NAME);
  const installed = await readMarker(fs, markerPath);

  // The skip fast-path (and the keep-existing network-failure fallback
  // below) require the on-disk install to speak THIS daemon's guest
  // protocol. A daemon upgraded in place next to a stale rootfs must
  // re-download — a protocol-N-1 supervisor booting under a protocol-N
  // daemon fails in confusing, run-level ways (e.g. it ignores
  // `credentials.source: "mmds"` and comes up with no credentials).
  // No marker at all (pre-marker install, hand-copied files) counts as
  // unverifiable, not as compatible.
  const installedProtocolOk = installed?.guestProtocol === GUEST_PROTOCOL_VERSION;

  // Skip: artifacts present, protocol verified, and either no version
  // pinned or the marker already matches the pinned version.
  if (present && installedProtocolOk && (!config.version || installed.version === config.version)) {
    log.info("Firecracker artifacts: present, skipping download", {
      arch,
      installedVersion: installed.version,
      requestedVersion: config.version ?? "(none)",
    });
    return;
  }

  const baseUrl = config.baseUrl ?? DEFAULT_ARTIFACTS_BASE_URL;
  try {
    await downloadAndInstall({
      fetchFn,
      fs,
      log,
      decompressZstd,
      arch,
      baseUrl,
      version: config.version,
      kernelPath: config.kernelPath,
      rootfsPath: config.rootfsPath,
      markerPath,
    });
  } catch (err) {
    // Protocol/checksum/arch mismatches are never acceptable — a present
    // (working) install must not mask a corrupt or incompatible release.
    if (err instanceof FatalArtifactsError) {
      throw err;
    }
    // Network/transient failure with artifacts already on disk: keep them
    // — but ONLY when the installed protocol is verified compatible. A
    // stale-protocol install must never be "kept" through a download
    // failure; that would resurrect exactly the daemon-upgraded-next-to-
    // old-rootfs state the protocol gate exists to prevent.
    if (present && installedProtocolOk) {
      log.warn("Firecracker artifacts: download failed, using existing on-disk artifacts", {
        error: getErrorMessage(err),
        kernelPath: config.kernelPath,
        rootfsPath: config.rootfsPath,
      });
      return;
    }
    // Nothing usable on disk (absent, or present at an incompatible guest
    // protocol) and we could not fetch: the daemon cannot run VMs.
    throw new Error(
      `Firecracker guest artifacts are ${present ? `installed at an incompatible guest protocol (daemon speaks ${GUEST_PROTOCOL_VERSION})` : "missing"} and could not be downloaded: ${getErrorMessage(err)}. ` +
        `Pin FIRECRACKER_ARTIFACTS_VERSION to a reachable release, ` +
        `build them locally with \`bun run firecracker:build\` (then set FIRECRACKER_ARTIFACTS_LOCAL=1), ` +
        `or check network access to ${baseUrl}.`,
    );
  }
}

interface InstallCtx {
  fetchFn: typeof fetch;
  fs: ArtifactsFs;
  log: Logger;
  decompressZstd: (bytes: Uint8Array) => Uint8Array;
  arch: GuestArch;
  baseUrl: string;
  version: string | undefined;
  kernelPath: string;
  rootfsPath: string;
  markerPath: string;
}

async function downloadAndInstall(ctx: InstallCtx): Promise<void> {
  const { fetchFn, fs, log, decompressZstd, arch, baseUrl, version } = ctx;

  // 1. Manifest — the trust anchor for the two file downloads.
  const manifestUrl = assetUrl(baseUrl, version, MANIFEST_ASSET_NAME);
  log.info("Firecracker artifacts: fetching manifest", { url: manifestUrl });
  const manifestRes = await fetchFn(manifestUrl);
  if (!manifestRes.ok) {
    throw new Error(`GET ${manifestUrl} → HTTP ${manifestRes.status}`);
  }
  const manifest = artifactsManifestSchema.parse(await manifestRes.json());

  // 2. Protocol gate — ALWAYS fatal: this daemon build cannot drive
  //    artifacts published under a different guest protocol.
  if (manifest.guest_protocol !== GUEST_PROTOCOL_VERSION) {
    throw new FatalArtifactsError(
      `guest-protocol mismatch: daemon speaks ${GUEST_PROTOCOL_VERSION}, ` +
        `manifest (version ${manifest.version}) declares ${manifest.guest_protocol}. ` +
        `Upgrade/downgrade the daemon to match the artifact release, or pin ` +
        `FIRECRACKER_ARTIFACTS_VERSION to a release built for protocol ${GUEST_PROTOCOL_VERSION}.`,
    );
  }

  const entry = manifest.artifacts[arch];
  if (!entry) {
    throw new FatalArtifactsError(
      `release ${manifest.version} publishes no Firecracker artifacts for arch "${arch}" ` +
        `(available: ${Object.keys(manifest.artifacts).join(", ") || "none"})`,
    );
  }

  // 3. Kernel — downloaded and verified as-is (uncompressed).
  const vmlinuxUrl = assetUrl(baseUrl, version, `vmlinux-${arch}`);
  log.info("Firecracker artifacts: downloading kernel", { url: vmlinuxUrl });
  const kernel = await downloadHashed(fetchFn, vmlinuxUrl);
  verifyChecksum(
    "vmlinux",
    kernel.sha256,
    entry.vmlinux.sha256,
    kernel.bytes.byteLength,
    entry.vmlinux.size,
  );

  // 4. Rootfs — downloaded compressed, verified after decompression against
  //    the manifest sha256 (which is the DECOMPRESSED file's digest).
  const rootfsUrl = assetUrl(baseUrl, version, `rootfs-${arch}.ext4.zst`);
  log.info("Firecracker artifacts: downloading rootfs", { url: rootfsUrl });
  const rootfsCompressed = await downloadHashed(fetchFn, rootfsUrl);
  if (rootfsCompressed.bytes.byteLength !== entry.rootfs.compressed_size) {
    throw new FatalArtifactsError(
      `rootfs compressed size mismatch: got ${rootfsCompressed.bytes.byteLength} bytes, ` +
        `manifest declares ${entry.rootfs.compressed_size}`,
    );
  }
  // Bun ships a native zstd codec (Bun.zstdDecompressSync) — no external
  // dependency and no shell-out to the `zstd` binary.
  const rootfsBytes = decompressZstd(rootfsCompressed.bytes);
  const rootfsSha = new Bun.CryptoHasher("sha256").update(rootfsBytes).digest("hex");
  verifyChecksum(
    "rootfs",
    rootfsSha,
    entry.rootfs.sha256,
    rootfsBytes.byteLength,
    entry.rootfs.size,
  );

  // 5. Atomic install — tmp write then rename, so a crash mid-write never
  //    leaves the engine reading a half-written kernel/rootfs.
  await fs.mkdirp(dirname(ctx.kernelPath));
  await fs.mkdirp(dirname(ctx.rootfsPath));
  await installAtomic(fs, ctx.kernelPath, kernel.bytes);
  await installAtomic(fs, ctx.rootfsPath, rootfsBytes);

  // 6. Marker last — only after both files are in place, so a partial
  //    install never records a version it did not finish.
  await fs.writeText(
    ctx.markerPath,
    JSON.stringify({ version: manifest.version, guest_protocol: manifest.guest_protocol }),
  );

  log.info("Firecracker artifacts: installed", {
    arch,
    version: manifest.version,
    guestProtocol: manifest.guest_protocol,
    kernelPath: ctx.kernelPath,
    rootfsPath: ctx.rootfsPath,
  });
}

function verifyChecksum(
  name: string,
  actualSha: string,
  expectedSha: string,
  actualSize: number,
  expectedSize: number,
): void {
  if (actualSha !== expectedSha) {
    throw new FatalArtifactsError(
      `${name} checksum mismatch: computed ${actualSha}, manifest declares ${expectedSha} ` +
        `(corrupt download or tampered asset)`,
    );
  }
  if (actualSize !== expectedSize) {
    throw new FatalArtifactsError(
      `${name} size mismatch: got ${actualSize} bytes, manifest declares ${expectedSize}`,
    );
  }
}

async function installAtomic(fs: ArtifactsFs, finalPath: string, bytes: Uint8Array): Promise<void> {
  const tmpPath = `${finalPath}.tmp-${process.pid}`;
  try {
    await fs.writeBytes(tmpPath, bytes);
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    await fs.remove(tmpPath).catch(() => {});
    throw err;
  }
}

interface InstalledMarker {
  version: string;
  /** Absent on markers written before the protocol was recorded. */
  guestProtocol: number | undefined;
}

async function readMarker(fs: ArtifactsFs, markerPath: string): Promise<InstalledMarker | null> {
  const text = await fs.readText(markerPath);
  if (!text) return null;
  try {
    const parsed = z
      .object({ version: z.string(), guest_protocol: z.number().int().optional() })
      .safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    return { version: parsed.data.version, guestProtocol: parsed.data.guest_protocol };
  } catch {
    return null;
  }
}
