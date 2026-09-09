// SPDX-License-Identifier: Apache-2.0
/// <reference types="bun" />

/**
 * Gate — the GitHub Actions workflows must lint.
 *
 * `bun run check` covered every language in this repo except the one that
 * decides whether the rest of the checks run at all. Eighteen workflow files,
 * ~4k lines of YAML and embedded shell, were held to prettier's formatting and
 * nothing else: a typo in a context path, a `needs` pointing at a job that no
 * longer exists, a misspelt runner label, an unclosed `${{ }}` — none of it was
 * caught before GitHub itself tried to run the file, and a workflow that fails
 * to parse simply does not run. On a repo whose `main` ruleset requires no
 * status checks (see #1230), a workflow that silently stops running is a gate
 * that silently stops existing.
 *
 * This wraps `actionlint`, which is the linter for that language.
 *
 * ## Why a pinned download and not a dependency
 *
 * actionlint is a Go binary. Its author publishes GitHub releases and a Docker
 * image, and nothing on npm. The npm package literally named `actionlint` is
 * NOT it — an unrelated wasm build published by `hops-release`, no source
 * repository declared, last touched in 2022. Depending on it would be handing
 * a third party the right to run code in every developer's install.
 *
 * So the binary comes from the author's own release page, pinned to an exact
 * version, and its SHA-256 is verified against {@link CHECKSUMS} BEFORE the
 * file is ever marked executable. Those digests are transcribed from the
 * signed `actionlint_<version>_checksums.txt` of that release. A mismatch
 * aborts and leaves nothing on disk. Bumping the version means replacing every
 * digest in the same commit — that is the point, not an inconvenience.
 *
 * ## Why shellcheck and pyflakes are switched off
 *
 * actionlint shells out to `shellcheck` for `run:` blocks when it finds one on
 * PATH. Ubuntu runners ship shellcheck; a developer's Mac generally does not.
 * Left on, this gate would report different findings depending on whose
 * machine ran it — green locally, red in CI, for a diff that changed neither.
 * A check whose verdict depends on the host is a check that lies, so both
 * integrations are disabled explicitly rather than left to ambient discovery.
 *
 * What this costs, measured at the time of writing: three `SC2129` style
 * suggestions ("consider using { cmd1; cmd2; } >> file") in `preview.yml` and
 * `release.yml`. Nothing else. Adding shellcheck back is a separate decision
 * that has to pin shellcheck the same way this pins actionlint.
 *
 * ## What this does and does not catch
 *
 * Verified against a deliberately broken workflow: undefined step ids,
 * misspelt context properties, `needs` on a job that does not exist, unknown
 * runner labels, malformed expressions, and `github.event.*` interpolated
 * straight into a `run:` script (the script-injection rule).
 *
 * It does NOT flag a `steps.*.outputs.*` interpolated into a `run:` — that is
 * outside actionlint's untrusted-input set, which covers attacker-controlled
 * event fields only. The convention of routing step outputs through `env:`
 * (see `conformance-monitor.yml`) remains a matter of review, not of this gate.
 * It also does not verify that an action reference resolves: `uses:
 * actions/checkout@v99999` passes, because resolving it needs the network.
 */

import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Pinned release. Bumping this means re-transcribing every digest below. */
const VERSION = "1.7.12";

/**
 * SHA-256 of each release tarball, from
 * `https://github.com/rhysd/actionlint/releases/download/v{VERSION}/actionlint_{VERSION}_checksums.txt`.
 * Keyed by the `<os>_<arch>` slug that appears in the asset name.
 */
const CHECKSUMS: Readonly<Record<string, string>> = {
  darwin_amd64: "5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644",
  darwin_arm64: "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
  linux_amd64: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
  linux_arm64: "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
};

const ROOT = join(import.meta.dir, "..");
const CACHE_DIR = join(ROOT, "node_modules/.cache/actionlint", VERSION);
const BINARY = join(CACHE_DIR, "actionlint");

/** Map Bun's platform/arch onto the slug used in the release asset names. */
export function platformSlug(platform: string, arch: string): string {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : undefined;
  if (!os || !cpu) {
    throw new Error(
      `actionlint publishes no release for ${platform}/${arch}. ` +
        `Supported here: darwin|linux × arm64|x64.`,
    );
  }
  return `${os}_${cpu}`;
}

function assetUrl(slug: string): string {
  return (
    `https://github.com/rhysd/actionlint/releases/download/v${VERSION}/` +
    `actionlint_${VERSION}_${slug}.tar.gz`
  );
}

/**
 * Fetch the tarball, refuse it unless its digest matches, then extract the
 * single binary we want. Nothing is made executable before the digest check.
 */
async function download(slug: string): Promise<void> {
  const url = assetUrl(slug);
  const expected = CHECKSUMS[slug];
  if (!expected) throw new Error(`No pinned checksum for ${slug} — add one before using it.`);

  process.stdout.write(`[verify:workflows] fetching actionlint ${VERSION} (${slug})…\n`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(
      `Could not download actionlint ${VERSION} (${slug}): HTTP ${res.status} from ${url}. ` +
        `This gate needs network access on its first run; the binary is cached afterwards.`,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());

  const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for actionlint ${VERSION} (${slug}).\n` +
        `  expected ${expected}\n  actual   ${actual}\n` +
        `Refusing to run it. Either the release was re-cut, or the download was tampered with.`,
    );
  }

  // Extract only after the bytes are vouched for. A fresh directory each time
  // so a half-extracted previous attempt cannot be mistaken for a good cache.
  rmSync(CACHE_DIR, { recursive: true, force: true });
  mkdirSync(CACHE_DIR, { recursive: true });
  const tarball = join(CACHE_DIR, "actionlint.tar.gz");
  await Bun.write(tarball, bytes);

  const tar = Bun.spawnSync(["tar", "xzf", tarball, "-C", CACHE_DIR, "actionlint"], {
    stderr: "pipe",
  });
  if (tar.exitCode !== 0) {
    throw new Error(`Extracting actionlint failed: ${tar.stderr.toString().trim()}`);
  }
  rmSync(tarball, { force: true });
  chmodSync(BINARY, 0o755);
}

async function main(): Promise<number> {
  if (!existsSync(BINARY)) {
    await download(platformSlug(process.platform, process.arch));
  }

  const run = Bun.spawnSync(
    [
      BINARY,
      "-no-color",
      "-oneline",
      // Both integrations off on purpose — see the header.
      "-shellcheck=",
      "-pyflakes=",
    ],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );

  const out = `${run.stdout.toString()}${run.stderr.toString()}`.trim();
  if (run.exitCode === 0) {
    process.stdout.write("[verify:workflows] OK — actionlint reports no findings.\n");
    return 0;
  }
  process.stdout.write(`${out}\n`);
  process.stdout.write(
    "\n[verify:workflows] actionlint reported the findings above. " +
      "Rule reference: https://github.com/rhysd/actionlint/blob/main/docs/checks.md\n",
  );
  return 1;
}

if (import.meta.main) {
  process.exit(await main());
}
