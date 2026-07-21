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
 *   - `firecracker-artifacts-manifest.json`     (per release, all arches)
 *   - `firecracker-artifacts-manifest.json.sig` (detached Ed25519 signature)
 *
 * At daemon boot (before the orchestrator's initialize()) the resolver
 * downloads the manifest, verifies its detached Ed25519 signature against a
 * source-pinned public key (the manifest is the ROOT OF TRUST for the guest
 * hashes, so it must itself be authenticated), then downloads the two files
 * for the current arch, verifies their SHA256 against the now-trusted
 * manifest, decompresses the rootfs (zstd, bounded), and installs
 * both atomically (tmp write + rename) into the paths the engine reads
 * (FIRECRACKER_KERNEL_PATH / FIRECRACKER_ROOTFS_PATH). A version marker
 * records what is installed so subsequent boots skip the download.
 *
 * Failure policy:
 *   - artifacts already present + network/download failure → warn, keep
 *     what is on disk, continue booting.
 *   - artifacts missing + download failure → fatal, with an actionable
 *     message (build locally or set the env vars).
 *   - guest-protocol mismatch, checksum mismatch, or a missing/invalid
 *     manifest signature → ALWAYS fatal (a corrupt/tampered asset, an
 *     unsigned release, or artifacts this daemon cannot run).
 *
 * Dev opt-out: `FIRECRACKER_ARTIFACTS_LOCAL=1` skips the resolver
 * entirely — the developer builds artifacts locally with
 * `bun run firecracker:build` and iterates on guest/ without a download.
 */

import { dirname, join } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createPublicKey, verify as ed25519Verify } from "node:crypto";
import { z } from "zod";
import { getErrorMessage } from "@appstrate/core/errors";
import { normalizeVersion, stripVersionPrefix } from "@appstrate/core/semver";
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
 *   3 — standard rootfs browser contract (pinned Chromium, authenticated
 *       worker, setuid driver/browser wrappers, and UID-aware nftables). A
 *       browser-capable daemon must not accept a protocol-2 artifact that
 *       lacks those fixed paths and identities.
 *   2 — MMDS credential broker (config-drive `credentials.source: "mmds"`
 *       strips RUN_TOKEN/APPSTRATE_SINK_SECRET off the drive; a protocol-1
 *       supervisor ignores the field, never fetches MMDS, and boots the
 *       run without credentials).
 *   1 — initial config-drive contract.
 */
export const GUEST_PROTOCOL_VERSION = 3;

/** GitHub Release download base for this repo (versioned + `latest`). */
export const DEFAULT_ARTIFACTS_BASE_URL = "https://github.com/appstrate/appstrate/releases";

/** Combined manifest asset name (one per release, all arches). */
export const MANIFEST_ASSET_NAME = "firecracker-artifacts-manifest.json";

/**
 * Detached signature asset for the manifest (base64 raw Ed25519 signature,
 * one line, over the exact manifest bytes). Published alongside the manifest
 * by the release workflow and verified against {@link ARTIFACTS_SIGNING_PUBKEY}
 * BEFORE any hash inside the manifest is trusted (see the trust note in
 * {@link downloadAndInstall}).
 */
export const MANIFEST_SIGNATURE_ASSET_NAME = "firecracker-artifacts-manifest.json.sig";

/**
 * Pinned Ed25519 public key (base64 raw 32 bytes) the manifest signature is
 * verified against. This is the ROOT OF TRUST for guest-artifact integrity:
 * the manifest declares the kernel/rootfs sha256 hashes, so a manifest an
 * attacker can forge (by replacing the release asset + matching a malicious
 * rootfs) would boot a guest that receives MMDS credentials. Because the key
 * lives in source (not fetched from the release), only the release-key holder
 * can mint a manifest this daemon will trust.
 *
 * Overridable ONLY via `FIRECRACKER_ARTIFACTS_PUBKEY` for testing / bring-your-
 * own-release signing — never fetched from the network.
 *
 * TODO: bake real key — replace this placeholder with the base64 raw Ed25519
 * public key of the release signing keypair once it is generated and stored in
 * the release workflow secrets. Until then the resolver fails closed (a
 * placeholder cannot verify anything): set FIRECRACKER_ARTIFACTS_PUBKEY, or use
 * FIRECRACKER_ARTIFACTS_LOCAL=1 to build guest artifacts locally.
 */
export const ARTIFACTS_SIGNING_PUBKEY = "__FIRECRACKER_ARTIFACTS_ED25519_PUBKEY__";

/**
 * Absolute ceiling on the DECLARED uncompressed rootfs size.
 * The manifest is signature-verified, so `entry.rootfs.size` is trusted input
 * from the release-key holder — but a compromised key (or a corrupt release)
 * could declare an absurd size to OOM the daemon at boot. Reject anything above
 * this ceiling BEFORE decompressing. Sized well above a real guest rootfs
 * (~1.3 GB today) with headroom for growth.
 *
 * Residual: `Bun.zstdDecompressSync` returns the whole buffer with no streaming
 * bound, so it still allocates the decompressed output in one shot. Defense in
 * depth: the compressed asset's byte length is checked against the signed
 * manifest's `compressed_size` (bounding the fetched input), the declared
 * uncompressed `size` is capped here (bounding what we accept), and the
 * post-decompression sha256 + exact-size check rejects any mismatch. A true
 * streaming zstd bound would need a chunked codec Bun does not currently expose.
 */
const MAX_ROOTFS_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB

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
  /**
   * Base64 raw Ed25519 public key the manifest signature is verified against.
   * Test seam — production resolves it from `FIRECRACKER_ARTIFACTS_PUBKEY` or
   * the pinned {@link ARTIFACTS_SIGNING_PUBKEY} constant.
   */
  manifestPublicKey?: string;
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
    return `${base}/download/v${stripVersionPrefix(version)}/${asset}`;
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

/** Fetch `url` and return the raw response bytes (throws on non-2xx). */
async function fetchBytes(fetchFn: typeof fetch, url: string): Promise<Uint8Array> {
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`GET ${url} → HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Fetch the detached manifest signature (base64 raw Ed25519, one line). A
 * genuinely MISSING signature asset (404) is ALWAYS fatal — a release that
 * ships an unsigned manifest cannot be trusted, so we refuse to boot rather
 * than fall back to the "keep existing" network-failure path. A TRANSIENT
 * upstream error (5xx, a proxy hiccup) is NOT proof of an unsigned release, so
 * it propagates as an ordinary Error — matching how the manifest fetch
 * (`fetchBytes`) treats the same status — and the caller's keep-existing
 * fallback still applies. Transport errors thrown by `fetchFn` propagate the
 * same way.
 */
async function fetchManifestSignature(fetchFn: typeof fetch, url: string): Promise<string> {
  const res = await fetchFn(url);
  if (!res.ok) {
    if (res.status === 404) {
      throw new FatalArtifactsError(
        `manifest signature asset is missing (GET ${url} → HTTP 404). ` +
          `The release did not publish "${MANIFEST_SIGNATURE_ASSET_NAME}" — refusing to ` +
          `trust an unsigned Firecracker artifacts manifest.`,
      );
    }
    throw new Error(`GET ${url} → HTTP ${res.status}`);
  }
  return (await res.text()).trim();
}

/**
 * Resolve the pinned manifest signing key: explicit test/deploy override
 * (deps → `FIRECRACKER_ARTIFACTS_PUBKEY`) or the source-pinned constant. Fails
 * closed while the constant is still the placeholder — a placeholder cannot
 * verify anything, so booting past it would silently disable the trust anchor.
 */
function resolveManifestPublicKey(override: string | undefined): string {
  const key = override ?? process.env.FIRECRACKER_ARTIFACTS_PUBKEY ?? ARTIFACTS_SIGNING_PUBKEY;
  if (key.startsWith("__")) {
    throw new FatalArtifactsError(
      "Firecracker artifacts signing key is not provisioned: the pinned public key " +
        "is still a placeholder, so the manifest signature cannot be verified. Set " +
        "FIRECRACKER_ARTIFACTS_PUBKEY to the release Ed25519 public key (base64 raw " +
        "32 bytes), or use FIRECRACKER_ARTIFACTS_LOCAL=1 to build guest artifacts locally.",
    );
  }
  return key;
}

/** Import a base64 raw 32-byte Ed25519 public key as a node:crypto KeyObject. */
function importEd25519PublicKey(publicKeyBase64: string) {
  const bytes = Buffer.from(publicKeyBase64, "base64");
  if (bytes.length !== 32) {
    throw new FatalArtifactsError(
      `manifest signing key must decode to 32 bytes (got ${bytes.length}) — ` +
        `expected a base64 raw Ed25519 public key`,
    );
  }
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: bytes.toString("base64url") },
    format: "jwk",
  });
}

/**
 * Verify a detached Ed25519 signature over the raw manifest bytes. ALWAYS fatal
 * on failure (missing/short/invalid signature) — a manifest we cannot
 * cryptographically attribute to the release key is refused, never trusted.
 */
function verifyManifestSignature(
  manifestBytes: Uint8Array,
  signatureBase64: string,
  publicKeyBase64: string,
): void {
  const signature = Buffer.from(signatureBase64, "base64");
  if (signature.length !== 64) {
    throw new FatalArtifactsError(
      `manifest signature must decode to 64 bytes (got ${signature.length}) — ` +
        `expected a base64 raw Ed25519 signature`,
    );
  }
  const publicKey = importEd25519PublicKey(publicKeyBase64);
  const valid = ed25519Verify(null, manifestBytes, publicKey, signature);
  if (!valid) {
    throw new FatalArtifactsError(
      "manifest signature is invalid: the Firecracker artifacts manifest does not " +
        "verify against the pinned signing key (tampered manifest or wrong key). " +
        "Refusing to boot a guest from an unverified manifest.",
    );
  }
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

  // An on-disk install is TRUSTED only when its marker records THIS daemon's
  // guest protocol AND that it was signature-verified (`signed: true`). Both
  // the skip fast-path and the keep-existing network-failure fallback below
  // gate on this. A stale-protocol supervisor fails in confusing, run-level
  // ways (e.g. it ignores `credentials.source: "mmds"` and boots with no
  // credentials); a marker without `signed: true` (pre-signing daemon,
  // hand-copied files, or no marker at all) was never signature-attested. Both
  // count as untrusted → re-download, running the signature gate before trust.
  const installedTrusted =
    installed?.guestProtocol === GUEST_PROTOCOL_VERSION && installed?.signed === true;

  // Skip: artifacts present, install trusted, and either no version pinned or
  // the marker already matches the pinned version.
  // Compare tag-normalized (strip a leading `v` and build metadata on either
  // side) — the marker records the manifest's version while operators
  // legitimately pin "v1.2.3" (host-env documents that form), and a raw string
  // compare would silently re-download the full kernel+rootfs on every boot.
  const versionMatches =
    !config.version ||
    (installed != null && normalizeVersion(installed.version) === normalizeVersion(config.version));
  if (present && installedTrusted && versionMatches) {
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
      manifestPublicKey: deps.manifestPublicKey,
    });
  } catch (err) {
    // Protocol/checksum/arch mismatches are never acceptable — a present
    // (working) install must not mask a corrupt or incompatible release.
    if (err instanceof FatalArtifactsError) {
      throw err;
    }
    // Network/transient failure with artifacts already on disk: keep them, but
    // ONLY when the install is trusted (protocol-compatible AND signature-
    // verified). Keeping a stale-protocol or never-attested install through a
    // download failure would boot unverified artifacts on every boot — a
    // transient (or attacker-induced) fetch failure bypassing the signed-marker
    // gate the skip path enforces.
    if (present && installedTrusted) {
      log.warn("Firecracker artifacts: download failed, using existing on-disk artifacts", {
        error: getErrorMessage(err),
        kernelPath: config.kernelPath,
        rootfsPath: config.rootfsPath,
      });
      return;
    }
    // Nothing usable on disk (absent, present at an incompatible guest
    // protocol, or present but never signature-verified) and we could not
    // fetch: the daemon cannot run VMs.
    const unusableReason = !present
      ? "missing"
      : installed?.guestProtocol !== GUEST_PROTOCOL_VERSION
        ? `installed at an incompatible guest protocol (daemon speaks ${GUEST_PROTOCOL_VERSION})`
        : "installed without signature verification (pre-signing or hand-copied install)";
    throw new Error(
      `Firecracker guest artifacts are ${unusableReason} and could not be downloaded: ${getErrorMessage(err)}. ` +
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
  /** Test-injectable override for the pinned manifest signing key. */
  manifestPublicKey: string | undefined;
}

async function downloadAndInstall(ctx: InstallCtx): Promise<void> {
  const { fetchFn, fs, log, decompressZstd, arch, baseUrl, version } = ctx;

  // 1. Manifest — the trust anchor for the two file downloads. It is
  //    downloaded as RAW BYTES and its detached Ed25519 signature is verified
  //    against a source-pinned public key BEFORE any field (kernel/rootfs
  //    sha256) is trusted. Without this, an attacker who can replace the
  //    manifest + matching malicious assets on the release would boot a guest
  //    that receives MMDS credentials — the manifest would "verify" its own
  //    tampered hashes. The signature closes that: only the release-key holder
  //    can mint a manifest this daemon will trust (the key lives in source, is
  //    never fetched from the network).
  const publicKey = resolveManifestPublicKey(ctx.manifestPublicKey);
  const manifestUrl = assetUrl(baseUrl, version, MANIFEST_ASSET_NAME);
  const signatureUrl = assetUrl(baseUrl, version, MANIFEST_SIGNATURE_ASSET_NAME);
  log.info("Firecracker artifacts: fetching signed manifest", {
    url: manifestUrl,
    signatureUrl,
  });
  const [manifestBytes, signatureB64] = await Promise.all([
    fetchBytes(fetchFn, manifestUrl),
    fetchManifestSignature(fetchFn, signatureUrl),
  ]);
  verifyManifestSignature(manifestBytes, signatureB64, publicKey);
  const manifest = artifactsManifestSchema.parse(
    JSON.parse(new TextDecoder().decode(manifestBytes)),
  );

  // 2. Version binding — ALWAYS fatal when a version is PINNED
  //    (FIRECRACKER_ARTIFACTS_VERSION): the signed manifest MUST declare that
  //    exact version. GitHub serves `download/v<tag>/<asset>` from whatever the
  //    tag currently points at, so without this an attacker who can place an
  //    OLDER but validly-signed manifest under the pinned tag's URL could roll
  //    the daemon back to superseded artifacts. Compare tag-normalized (strip a
  //    leading `v` and build metadata on either side). Not applied to the
  //    unpinned `latest` path — there is no expected version to bind against there.
  if (version) {
    const pinned = normalizeVersion(version);
    const declared = normalizeVersion(manifest.version);
    if (pinned !== declared) {
      throw new FatalArtifactsError(
        `guest-artifact version mismatch: pinned FIRECRACKER_ARTIFACTS_VERSION ` +
          `"${version}" but the signed manifest declares version "${manifest.version}". ` +
          `Refusing to install a release under a tag it was not signed for (possible ` +
          `rollback to older, still-validly-signed artifacts).`,
      );
    }
  }

  // 3. Protocol gate — ALWAYS fatal: this daemon build cannot drive
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

  // 4. Kernel — downloaded and verified as-is (uncompressed).
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

  // 5. Rootfs — downloaded compressed, verified after decompression against
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
  // Decompression cap: the manifest is signature-verified, so
  // `entry.rootfs.size` is trusted — but a compromised key or corrupt release
  // could declare an absurd uncompressed size to OOM the daemon at boot.
  // Reject anything above the absolute ceiling BEFORE decompressing.
  if (entry.rootfs.size > MAX_ROOTFS_UNCOMPRESSED_BYTES) {
    throw new FatalArtifactsError(
      `rootfs declares an uncompressed size of ${entry.rootfs.size} bytes, above ` +
        `the ${MAX_ROOTFS_UNCOMPRESSED_BYTES}-byte ceiling — refusing to decompress ` +
        `(possible decompression bomb or corrupt release).`,
    );
  }
  // Bun ships a native zstd codec (Bun.zstdDecompressSync) — no external
  // dependency and no shell-out to the `zstd` binary. The post-decompression
  // sha256 + exact-size check below is the final gate (see verifyChecksum).
  const rootfsBytes = decompressZstd(rootfsCompressed.bytes);
  const rootfsSha = new Bun.CryptoHasher("sha256").update(rootfsBytes).digest("hex");
  verifyChecksum(
    "rootfs",
    rootfsSha,
    entry.rootfs.sha256,
    rootfsBytes.byteLength,
    entry.rootfs.size,
  );

  // 6. Atomic install — tmp write then rename, so a crash mid-write never
  //    leaves the engine reading a half-written kernel/rootfs.
  await fs.mkdirp(dirname(ctx.kernelPath));
  await fs.mkdirp(dirname(ctx.rootfsPath));
  await installAtomic(fs, ctx.kernelPath, kernel.bytes);
  await installAtomic(fs, ctx.rootfsPath, rootfsBytes);

  // 7. Marker last — only after both files are in place, so a partial
  //    install never records a version it did not finish. `signed: true`
  //    records that this install went through signature verification above;
  //    the skip fast-path in ensureGuestArtifacts refuses to trust a marker
  //    lacking it (a pre-signing daemon never wrote it), forcing one
  //    re-download+verify.
  await fs.writeText(
    ctx.markerPath,
    JSON.stringify({
      version: manifest.version,
      guest_protocol: manifest.guest_protocol,
      signed: true,
    }),
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
  /**
   * True only when this install was written after signature verification.
   * Absent on markers written by a pre-signing daemon (or hand-copied), which
   * the skip fast-path treats as unverifiable → forces a re-download.
   */
  signed: boolean;
}

async function readMarker(fs: ArtifactsFs, markerPath: string): Promise<InstalledMarker | null> {
  const text = await fs.readText(markerPath);
  if (!text) return null;
  try {
    const parsed = z
      .object({
        version: z.string(),
        guest_protocol: z.number().int().optional(),
        // Only ever WRITTEN as `true`; absent on pre-signing/hand-copied markers.
        signed: z.literal(true).optional(),
      })
      .safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    return {
      version: parsed.data.version,
      guestProtocol: parsed.data.guest_protocol,
      signed: parsed.data.signed === true,
    };
  } catch {
    return null;
  }
}
