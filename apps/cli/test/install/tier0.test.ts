// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `lib/install/tier0.ts`.
 *
 * Scoped to the side-effect-free surface — the functions that shell out
 * (installBun, cloneAppstrateSource, runBunInstall, spawnDevServer) are
 * exercised end-to-end in `test-install.yml` CI jobs rather than stubbed
 * here, because the value of a unit-level assertion on "curl was called"
 * is low and the maintenance cost of scripted-subprocess mocks is high.
 *
 * What we do want locked down at the unit level:
 *   - `detectBun` returns a usable `{ found, path }` shape for both
 *     "bun on PATH" and "bun only in ~/.bun/bin" cases.
 *   - `writeEnvFile` writes 0600 (matches the Docker-tier contract).
 *   - Error classes carry actionable messages (no silent empty strings).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, chmod, stat, readFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { spawnSync } from "node:child_process";
import {
  detectBun,
  writeEnvFile,
  GitMissingError,
  cloneAppstrateSource,
} from "../../src/lib/install/tier0.ts";

let workDir: string;
const originalPath = process.env.PATH;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "appstrate-cli-tier0-"));
});

afterEach(async () => {
  process.env.PATH = originalPath;
  await rm(workDir, { recursive: true, force: true });
});

describe("detectBun", () => {
  it("returns { found: true, path: 'bun' } when bun is on PATH", async () => {
    if (platform() === "win32") return;
    // Shim a fake `bun` and put its directory on PATH.
    const shimDir = join(workDir, "shim");
    await mkdir(shimDir, { recursive: true });
    const shim = join(shimDir, "bun");
    await writeFile(shim, "#!/usr/bin/env bash\nexit 0\n");
    await chmod(shim, 0o755);
    process.env.PATH = `${shimDir}:${originalPath}`;
    const res = detectBun();
    expect(res.found).toBe(true);
    expect(res.local).toBe(false);
  });

  it("returns a boolean shape (no absolute path leaks back to callers)", () => {
    // Contract: `detectBun` only reports whether bun is findable via
    // spawn("bun") with the CLI-augmented PATH. It intentionally does
    // NOT hand back a `$HOME`-derived absolute path — that was the
    // dataflow CodeQL's `js/shell-command-injection-from-environment`
    // traced through to spawn(). Callers must rely on `"bun"` +
    // PATH-augmented env instead.
    const res = detectBun();
    expect(typeof res.found).toBe("boolean");
    expect(typeof res.local).toBe("boolean");
    // @ts-expect-error — `path` was removed in the CodeQL-hardening refactor.
    expect(res.path).toBeUndefined();
  });
});

describe("writeEnvFile", () => {
  it("writes the body verbatim to <dir>/.env", async () => {
    const body = "APP_URL=http://localhost:3000\nBETTER_AUTH_SECRET=abc123\n";
    await writeEnvFile(workDir, body);
    const round = await readFile(join(workDir, ".env"), "utf8");
    expect(round).toBe(body);
  });

  it("writes with 0600 mode (same contract as the Docker tiers)", async () => {
    if (platform() === "win32") return;
    await writeEnvFile(workDir, "BETTER_AUTH_SECRET=x\n");
    const s = await stat(join(workDir, ".env"));

    expect(s.mode & 0o777).toBe(0o600);
  });

  it("does not create the directory (unlike the Docker-tier sibling — Tier 0 clones first)", async () => {
    // Tier 0 writes `.env` INTO an already-cloned repo. It must NOT
    // silently materialize a missing parent (that would mask a failed
    // clone and leave the user with an `.env` but no source). Expect the
    // write to throw ENOENT.
    await expect(writeEnvFile(join(workDir, "not-cloned-yet"), "X=1\n")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("GitMissingError", () => {
  it("names the curl + tar fallback explicitly", () => {
    const err = new GitMissingError();
    expect(err.name).toBe("GitMissingError");
    expect(err.message).toMatch(/git/);
    expect(err.message).toMatch(/curl/);
    expect(err.message).toMatch(/tar/);
  });
});

/**
 * Regression: Tier 0 has no upgrade semantics — unlike tiers 1/2/3 it
 * cannot merge an existing `.env` or reuse an existing clone. The
 * de-facto guard preventing `appstrate install --tier 0` from clobbering
 * a user's work in a non-empty dir is `cloneAppstrateSource` itself,
 * which wraps `git clone` and relies on git's native refusal to clone
 * into a non-empty destination.
 *
 * This test locks that invariant down: a future refactor that replaces
 * the clone with `mkdir + tar extract` (no emptiness check of its own)
 * would silently lose the safety, and this test would catch it.
 *
 * Offline-safe: git's "destination path '...' already exists and is not
 * an empty directory" error fires BEFORE any network access (it's a
 * local stat on the destination), so we can point at a bogus git URL
 * and still exercise the refusal path without a live network. If git is
 * missing from the host (tarball fallback path) we skip — the fallback
 * path is a separate story and covered by e2e.
 */
describe("cloneAppstrateSource refuses non-empty dirs (regression)", () => {
  const gitAvailable =
    spawnSync(platform() === "win32" ? "where" : "which", ["git"], {
      stdio: "ignore",
    }).status === 0;

  it("rejects without touching the user's existing files", async () => {
    if (!gitAvailable) {
      // Tarball fallback has no emptiness check of its own — a separate
      // concern. Skip here; e2e covers the git-less host case.
      return;
    }

    // Drop two sentinel files that a user mid-install might have: a
    // populated `.env` they do not want overwritten and a
    // docker-compose.yml they might be hand-tweaking. At least one is
    // enough to trip git's "not empty" guard; we use two to prove no
    // file is touched.
    const envPath = join(workDir, ".env");
    const envBody = "BETTER_AUTH_SECRET=existing-value\nAPP_URL=http://localhost:3000\n";
    const composePath = join(workDir, "docker-compose.yml");
    const composeBody = "# user-edited — do not clobber\nservices: {}\n";
    await writeFile(envPath, envBody);
    await writeFile(composePath, composeBody);

    // Pre-state: establish that the dir is observably non-empty
    // BEFORE the call, so if the call were to somehow succeed by
    // deleting+cloning we'd still have a recorded baseline.
    const before = (await readdir(workDir)).sort();
    expect(before).toEqual([".env", "docker-compose.yml"]);

    // Bogus URL: git's emptiness check is local (stat on destination)
    // and fires before it resolves/connects to the URL. Using a
    // file:// URL to a nonexistent path keeps the test offline-safe
    // even if git's order of operations ever shifts.
    // The wrapper swallows git's stderr (stdio: "inherit" → terminal,
    // not captured), so we match the wrapper's own error shape:
    // "git clone failed: exit 128". Exit 128 is git's generic "clone
    // preconditions not met" — emptiness check, invalid URL, etc. We
    // care that the clone was refused; the sentinel-file assertions
    // below prove WHY (emptiness) rather than relying on message text.
    await expect(
      cloneAppstrateSource(workDir, {
        version: undefined,
        gitUrl: "file:///definitely/not/a/real/repo/path",
      }),
    ).rejects.toThrow(/git clone failed/i);

    // Invariant: the user's files must be byte-for-byte intact. This
    // is the stronger guarantee — "clone errored" is necessary but not
    // sufficient; what matters is that nothing was clobbered.
    expect(await readFile(envPath, "utf8")).toBe(envBody);
    expect(await readFile(composePath, "utf8")).toBe(composeBody);

    // And no stray files were deposited alongside them (e.g. a partial
    // `.git/` or `.appstrate-source.tar.gz` from a fallthrough path).
    const after = (await readdir(workDir)).sort();
    expect(after).toEqual([".env", "docker-compose.yml"]);
  });
});
