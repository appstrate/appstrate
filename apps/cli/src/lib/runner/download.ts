// SPDX-License-Identifier: Apache-2.0

/**
 * Binary acquisition for `runner install` / `runner update`: the appstrate
 * daemon binary (published by this repo's release CI) and the pinned
 * upstream firecracker VMM. Both are SHA-256 verified against a sidecar
 * checksum published next to the asset before they touch disk.
 *
 * The daemon binary is the compiled `appstrate-runner-<arch>` from
 * `.github/workflows/release.yml`; its checksum sidecar is
 * `<asset>.sha256`. Firecracker ships `<asset>.tgz` + `<asset>.tgz.sha256.txt`
 * on its own GitHub Releases.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPSTRATE_RELEASE_BASE,
  FIRECRACKER_RELEASE_BASE,
  daemonAssetName,
  type RunnerArch,
} from "./constants.ts";
import type { RunnerExec, RunnerFs, RunnerHttp } from "./exec.ts";

/** Hex SHA-256 of a byte buffer via Bun's baked-in hasher. */
export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/**
 * Extract the leading 64-hex token from a `sha256sum`-style manifest line
 * (`<hash>  <filename>` or `<hash> *<filename>`). Both the daemon sidecar
 * and firecracker's `.sha256.txt` use this shape.
 */
export function parseSha256(text: string): string {
  const first = text.trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{64}$/i.test(first)) {
    throw new Error(`malformed sha256 checksum: "${text.trim().slice(0, 80)}"`);
  }
  return first.toLowerCase();
}

/** Build the daemon asset URLs for a version tag (`1.2.3` or `latest`). */
export function daemonUrls(version: string, arch: RunnerArch): { binary: string; sha256: string } {
  const asset = daemonAssetName(arch);
  const base =
    version === "latest"
      ? `${APPSTRATE_RELEASE_BASE}/latest/download`
      : `${APPSTRATE_RELEASE_BASE}/download/v${version.replace(/^v/, "")}`;
  return { binary: `${base}/${asset}`, sha256: `${base}/${asset}.sha256` };
}

/**
 * Download the daemon binary + its sha256 sidecar, verify, and return the
 * bytes. Never writes to disk — the caller installs atomically at the
 * destination it controls (so `update` can swap over the live binary).
 */
export async function downloadDaemon(opts: {
  http: RunnerHttp;
  version: string;
  arch: RunnerArch;
}): Promise<Uint8Array> {
  const urls = daemonUrls(opts.version, opts.arch);
  const [bytes, sumText] = await Promise.all([
    opts.http.fetchBinary(urls.binary),
    opts.http.fetchText(urls.sha256),
  ]);
  const expected = parseSha256(sumText);
  const actual = sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(
      `daemon binary SHA-256 mismatch: expected ${expected}, got ${actual} — ` +
        `refusing to install (broken release or tampering).`,
    );
  }
  return bytes;
}

/** Build the firecracker tarball URLs for the pinned version. */
export function firecrackerUrls(
  version: string,
  arch: RunnerArch,
): { tarball: string; sha256: string; innerPath: string } {
  const tag = `v${version.replace(/^v/, "")}`;
  const asset = `firecracker-${tag}-${arch}.tgz`;
  return {
    tarball: `${FIRECRACKER_RELEASE_BASE}/${tag}/${asset}`,
    sha256: `${FIRECRACKER_RELEASE_BASE}/${tag}/${asset}.sha256.txt`,
    // Path of the binary inside the tarball.
    innerPath: `release-${tag}-${arch}/firecracker-${tag}-${arch}`,
  };
}

/**
 * Download the pinned firecracker VMM, verify its SHA-256, extract the
 * single binary from the tarball, and install it (0755) at `destPath`.
 * Uses `tar` for extraction (always present on a Linux host).
 */
export async function installFirecracker(opts: {
  http: RunnerHttp;
  exec: RunnerExec;
  fs: RunnerFs;
  version: string;
  arch: RunnerArch;
  destPath: string;
}): Promise<void> {
  const urls = firecrackerUrls(opts.version, opts.arch);
  const [tgz, sumText] = await Promise.all([
    opts.http.fetchBinary(urls.tarball),
    opts.http.fetchText(urls.sha256),
  ]);
  const expected = parseSha256(sumText);
  const actual = sha256Hex(tgz);
  if (actual !== expected) {
    throw new Error(
      `firecracker tarball SHA-256 mismatch: expected ${expected}, got ${actual} — ` +
        `refusing to install (broken download or tampering).`,
    );
  }

  const work = await mkdtemp(join(tmpdir(), "appstrate-firecracker-"));
  try {
    const tgzPath = join(work, "firecracker.tgz");
    await opts.fs.writeFile(tgzPath, tgz);
    const untar = await opts.exec.run("tar", ["-xzf", tgzPath, "-C", work]);
    if (!untar.ok) {
      throw new Error(
        `failed to extract firecracker tarball: ${untar.stderr || "tar exited non-zero"}`,
      );
    }
    const innerPath = join(work, urls.innerPath);
    const binary = await opts.fs.readFileBytes(innerPath);
    if (!binary) {
      throw new Error(`firecracker binary not found in tarball at ${urls.innerPath}`);
    }
    await opts.fs.installAtomic(opts.destPath, binary, 0o755);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
