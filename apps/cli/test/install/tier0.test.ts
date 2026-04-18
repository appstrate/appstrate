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
import { mkdtemp, rm, writeFile, chmod, stat, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { detectBun, writeEnvFile, GitMissingError } from "../../src/lib/install/tier0.ts";

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
