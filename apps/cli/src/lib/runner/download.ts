// SPDX-License-Identifier: Apache-2.0

/**
 * Binary acquisition for `runner install` / `runner update`: the appstrate
 * daemon binary (published by this repo's release CI) and the pinned
 * upstream firecracker VMM.
 *
 * The daemon binary is the compiled `appstrate-runner-<arch>` from
 * `.github/workflows/release.yml`. It is verified against the release's
 * minisign-signed `checksums.txt` — the SAME signed trust chain the CLI
 * itself ships under (`scripts/bootstrap-runner.sh` / `self-update`) — rather
 * than a bare same-origin `.sha256` sidecar, so a tampered mirror cannot swap
 * both the binary and its checksum. Firecracker ships `<asset>.tgz` +
 * `<asset>.tgz.sha256.txt` on its own GitHub Releases (upstream, verified
 * against its published sidecar).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  APPSTRATE_RELEASE_BASE,
  FIRECRACKER_RELEASE_BASE,
  daemonAssetName,
  type RunnerArch,
} from "./constants.ts";
import type { RunnerExec, RunnerFs, RunnerHttp } from "./exec.ts";
import type { ProgressFn } from "../download.ts";
import {
  fetchSignedText,
  parseChecksumLine,
  resolveLatestRelease,
  type ReleaseChannelDeps,
} from "../self-update.ts";
import { stripVersionPrefix } from "@appstrate/core/semver";

/** Hex SHA-256 of a byte buffer via Bun's baked-in hasher. */
export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/**
 * Extract the leading 64-hex token from a `sha256sum`-style manifest line
 * (`<hash>  <filename>` or `<hash> *<filename>`). Used to verify upstream
 * firecracker's own `.tgz.sha256.txt` sidecar (the daemon binary is verified
 * against the minisign-signed `checksums.txt` instead).
 */
export function parseSha256(text: string): string {
  const first = text.trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{64}$/i.test(first)) {
    throw new Error(`malformed sha256 checksum: "${text.trim().slice(0, 80)}"`);
  }
  return first.toLowerCase();
}

/**
 * The runner seams as the signed-artefact I/O `self-update` verifies with. The
 * work dir is a real temp dir, not `RunnerFs`: the minisign inputs are scratch
 * files, never host state.
 */
function releaseChannelDeps(opts: {
  http: RunnerHttp;
  exec: RunnerExec;
  fs: RunnerFs;
}): ReleaseChannelDeps {
  return {
    fetchText: (url) => opts.http.fetchText(url),
    fetchBinary: (url) => opts.http.fetchBinary(url),
    runCommand: (cmd, args) => opts.exec.run(cmd, args),
    writeFile: (path, data) => opts.fs.writeFile(path, data),
    makeWorkDir: () => mkdtemp(join(tmpdir(), "appstrate-runner-verify-")),
    removeDir: (path) => rm(path, { recursive: true, force: true }),
  };
}

/**
 * Turn the lockstep daemon version into a PINNED release tag.
 *
 * `resolveDaemonVersion()` (commands/runner.ts) yields the literal `"latest"`
 * for a dev build of the CLI, and that is what `runner install` and
 * `runner update` pass down. It is resolved here the same way
 * `appstrate self-update` resolves it — the tag named by the minisign-signed
 * channel manifest — instead of being turned into a `releases/latest/download`
 * URL, which follows whichever Release GitHub marks latest (a `cli@`/`core@`
 * one carries no runner assets).
 *
 * Anything that is not `"latest"` is already a pin and passes straight through
 * without a network call.
 */
export async function resolveDaemonReleaseVersion(
  version: string,
  deps: ReleaseChannelDeps,
): Promise<string> {
  if (version !== "latest") return version;
  try {
    return await resolveLatestRelease(deps);
  } catch (err) {
    // Only a dev CLI gets here: a release CLI pins the daemon to its own
    // version, so the escape hatch is running one.
    throw new Error(
      `${(err as Error).message}\n` +
        `A dev CLI resolves the runner daemon to the latest release; a release CLI pins it ` +
        `to its own version. Use a release CLI instead, e.g. ` +
        `\`curl -fsSL https://get.appstrate.dev/runner | APPSTRATE_VERSION=X.Y.Z bash\`.`,
      { cause: err },
    );
  }
}

/**
 * Build the daemon asset URLs for a PINNED version tag (`1.2.3` or `v1.2.3`).
 * The daemon's digest is a line in the release-wide `checksums.txt` (minisign
 * signed), so those two URLs anchor the trust.
 *
 * `"latest"` is deliberately NOT accepted — see
 * {@link resolveDaemonReleaseVersion}, which every caller goes through first.
 * A caller that reaches here with `"latest"` has a bug, and a loud throw beats
 * `releases/latest/download` handing back three 404s (or, worse, assets from a
 * release this daemon was never built against).
 */
export function daemonUrls(
  version: string,
  arch: RunnerArch,
): { binary: string; checksums: string; checksumsSig: string } {
  if (version === "latest") {
    throw new Error(
      `daemonUrls requires a pinned release version, got "latest" — resolve it through ` +
        `resolveDaemonReleaseVersion() first (GitHub's releases/latest is not guaranteed ` +
        `to be a platform v* release carrying the runner assets).`,
    );
  }
  const asset = daemonAssetName(arch);
  const base = `${APPSTRATE_RELEASE_BASE}/download/v${stripVersionPrefix(version)}`;
  return {
    binary: `${base}/${asset}`,
    checksums: `${base}/checksums.txt`,
    checksumsSig: `${base}/checksums.txt.minisig`,
  };
}

/**
 * Stream the daemon binary to a staged file next to `destPath` and verify it
 * against the release's minisign-signed `checksums.txt`. Returns the staged
 * path; the caller promotes it atomically onto `destPath` (so `update` can
 * swap over the live binary) — or, on any verification failure, the staged
 * file is removed and this throws.
 *
 * Streaming (not buffering the whole ~70 MB into memory) gives a live progress
 * spinner and a stall watchdog: a wedged GitHub→CDN redirect aborts with an
 * actionable error instead of hanging forever (issue #821).
 *
 * minisign is REQUIRED (fail-closed, matching `self-update` and
 * `scripts/bootstrap-runner.sh`): a signed-checksum check the host cannot
 * perform is no check at all. On a runner host provisioned via
 * `get.appstrate.dev/runner`, minisign is already present (the bootstrap
 * verified the CLI with it).
 */
export async function downloadDaemon(opts: {
  http: RunnerHttp;
  exec: RunnerExec;
  fs: RunnerFs;
  version: string;
  arch: RunnerArch;
  /** Final install path; the staged download lands in the same directory. */
  destPath: string;
  onProgress?: ProgressFn;
}): Promise<{ stagedPath: string }> {
  // A dev CLI passes "latest"; turn it into a concrete platform `v*` release
  // BEFORE any URL is built (see resolveDaemonReleaseVersion). Every message
  // below then names the release that was actually fetched, not "latest".
  const deps = releaseChannelDeps(opts);
  const version = await resolveDaemonReleaseVersion(opts.version, deps);
  const urls = daemonUrls(version, opts.arch);
  const asset = daemonAssetName(opts.arch);
  // Fixed staged name (no pid suffix): a retry after a crash/SIGKILL simply
  // overwrites the previous partial file instead of accumulating hidden ~70 MB
  // orphans next to the binary. The SHA-256 gate below fails closed if two
  // concurrent installs ever interleave writes.
  const stagedPath = join(dirname(opts.destPath), `.${asset}.download`);

  // 1. Fetch + verify the small signed manifest BEFORE the large binary
  //    stream: it fails fast on a bad/missing signature without pulling the
  //    ~70 MB daemon, and it keeps the stream off the parallel path so a
  //    sidecar reject can never run cleanup while the stream is still writing
  //    `stagedPath`. A 404 here almost always means this release shipped
  //    WITHOUT runner assets — the firecracker/daemon build jobs are decoupled
  //    from the core release (release.yml) and may have failed for this tag.
  const workDir = await deps.makeWorkDir();
  let checksumsTxt: string;
  try {
    checksumsTxt = await fetchSignedText(deps, {
      url: urls.checksums,
      sigUrl: urls.checksumsSig,
      workDir,
      subject: "the runner checksums manifest",
    });
  } catch (err) {
    throw asRunnerAssetError(err, version, asset);
  } finally {
    await deps.removeDir(workDir).catch(() => {});
  }

  // 2. Stream the daemon binary to disk, then verify its streamed digest
  //    against the (now trusted) manifest line for this asset.
  let actual: string;
  try {
    ({ sha256: actual } = await opts.http.fetchToFile(urls.binary, stagedPath, opts.onProgress));
  } catch (err) {
    throw asRunnerAssetError(err, version, asset);
  }
  try {
    const expected = parseChecksumLine(checksumsTxt, asset);
    if (actual !== expected) {
      throw new Error(
        `daemon binary SHA-256 mismatch: expected ${expected}, got ${actual} — ` +
          `the download does NOT match the signed checksums manifest. ` +
          `Refusing to install (broken release or tampering).`,
      );
    }
  } catch (err) {
    // Never leave an unverified staged binary behind.
    await opts.fs.remove(stagedPath).catch(() => {});
    throw err;
  }

  return { stagedPath };
}

/**
 * Map a raw fetch failure to an actionable error. `fetchBinary` / `fetchText`
 * throw `GET <url> → HTTP <status>`; a 404 on a runner asset means the release
 * omitted them (the decoupled firecracker/daemon build jobs failed for this
 * tag). The daemon version is locked to the CLI, so the fix is to pin a CLI
 * release that shipped runner assets.
 *
 * `version` is always a resolved platform tag here (`downloadDaemon` runs
 * `resolveDaemonReleaseVersion` first), so the message names the release the
 * operator has to act on — never the un-actionable word "latest".
 */
function asRunnerAssetError(err: unknown, version: string, asset: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/HTTP 404/.test(msg)) {
    return new Error(
      `Runner asset "${asset}" is missing from release v${stripVersionPrefix(version)} ` +
        `(HTTP 404). This release was ` +
        `published WITHOUT runner assets — the firecracker/daemon build jobs are decoupled ` +
        `from the core release (release.yml) and likely failed for this tag. The daemon ` +
        `version is locked to the CLI version, so pin a CLI release that shipped runner ` +
        `assets and retry: \`appstrate self-update --release <previous-version>\` (or ` +
        `re-bootstrap with APPSTRATE_VERSION=<previous-version>), then re-run ` +
        `\`appstrate runner install\`. Releases: https://github.com/appstrate/appstrate/releases`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

/** Build the firecracker tarball URLs for the pinned version. */
export function firecrackerUrls(
  version: string,
  arch: RunnerArch,
): { tarball: string; sha256: string; innerPath: string; jailerInnerPath: string } {
  const tag = `v${stripVersionPrefix(version)}`;
  const asset = `firecracker-${tag}-${arch}.tgz`;
  return {
    tarball: `${FIRECRACKER_RELEASE_BASE}/${tag}/${asset}`,
    sha256: `${FIRECRACKER_RELEASE_BASE}/${tag}/${asset}.sha256.txt`,
    // Paths of the two binaries inside the tarball. The jailer ships in
    // the SAME release archive — one verified download covers both.
    innerPath: `release-${tag}-${arch}/firecracker-${tag}-${arch}`,
    jailerInnerPath: `release-${tag}-${arch}/jailer-${tag}-${arch}`,
  };
}

/**
 * Download the pinned firecracker release, verify its SHA-256, extract
 * the VMM and the jailer from the tarball, and install them (0755) at
 * `destPath` / `jailerDestPath`. One verified archive covers both — the
 * daemon requires the pair to come from the same release
 * (FIRECRACKER_JAILER=on confinement). Uses `tar` for extraction
 * (always present on a Linux host).
 */
export async function installFirecracker(opts: {
  http: RunnerHttp;
  exec: RunnerExec;
  fs: RunnerFs;
  version: string;
  arch: RunnerArch;
  destPath: string;
  jailerDestPath: string;
  onProgress?: ProgressFn;
}): Promise<void> {
  const urls = firecrackerUrls(opts.version, opts.arch);
  const work = await mkdtemp(join(tmpdir(), "appstrate-firecracker-"));
  try {
    // Fetch the small checksum sidecar FIRST, then stream the tarball — keeping
    // the big stream off the parallel path (a Promise.all reject would run the
    // `finally` rm(work) while the stream is still writing into it) and failing
    // fast if the sidecar is missing. Extracted below, never renamed onto a
    // live target, so the temp dir is fine.
    const expected = parseSha256(await opts.http.fetchText(urls.sha256));
    const tgzPath = join(work, "firecracker.tgz");
    const { sha256: actual } = await opts.http.fetchToFile(urls.tarball, tgzPath, opts.onProgress);
    if (actual !== expected) {
      throw new Error(
        `firecracker tarball SHA-256 mismatch: expected ${expected}, got ${actual} — ` +
          `refusing to install (broken download or tampering).`,
      );
    }

    const untar = await opts.exec.run("tar", ["-xzf", tgzPath, "-C", work]);
    if (!untar.ok) {
      throw new Error(
        `failed to extract firecracker tarball: ${untar.stderr || "tar exited non-zero"}`,
      );
    }
    for (const [inner, dest] of [
      [urls.innerPath, opts.destPath],
      [urls.jailerInnerPath, opts.jailerDestPath],
    ] as const) {
      const binary = await opts.fs.readFileBytes(join(work, inner));
      if (!binary) {
        throw new Error(`binary not found in firecracker tarball at ${inner}`);
      }
      await opts.fs.installAtomic(dest, binary, 0o755);
    }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
