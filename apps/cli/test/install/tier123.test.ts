// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `lib/install/tier123.ts`.
 *
 * Covers the Docker-tier install primitives:
 *   - `writeComposeFile`: the embedded per-tier YAML is materialized
 *     correctly (tier 1 = postgres only, tier 2 = + redis, tier 3 = + minio).
 *   - `writeEnvFile`: `.env` is written with 0600 mode so it survives
 *     backup-tool indexing without leaking BETTER_AUTH_SECRET.
 *   - `assertDockerAvailable`: when `docker` is absent from PATH it
 *     raises `DockerMissingError`, and when a fake `docker` on PATH
 *     returns 0 the probe resolves cleanly. Uses a scratch PATH pointing
 *     at a tmpdir with an executable shim — no real docker required.
 *   - `waitForAppstrate`: resolves when `waitForHttp` returns true,
 *     throws a helpful message otherwise. Exercised indirectly via the
 *     real `fetch` stub because `waitForHttp` lives in `./os.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, stat, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import {
  writeComposeFile,
  writeEnvFile,
  assertDockerAvailable,
  waitForAppstrate,
  DockerMissingError,
} from "../../src/lib/install/tier123.ts";

let workDir: string;
const originalPath = process.env.PATH;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "appstrate-cli-tier123-"));
});

afterEach(async () => {
  process.env.PATH = originalPath;
  globalThis.fetch = originalFetch;
  await rm(workDir, { recursive: true, force: true });
});

describe("writeComposeFile", () => {
  it("writes tier 1 compose with postgres but no redis / minio", async () => {
    const dir = join(workDir, "t1");
    await writeComposeFile(dir, 1);
    const body = await readFile(join(dir, "docker-compose.yml"), "utf8");
    expect(body).toMatch(/^\s{2}postgres:/m);
    expect(body).not.toMatch(/^\s{2}redis:/m);
    expect(body).not.toMatch(/^\s{2}minio:/m);
  });

  it("writes tier 2 compose with postgres + redis, no minio", async () => {
    const dir = join(workDir, "t2");
    await writeComposeFile(dir, 2);
    const body = await readFile(join(dir, "docker-compose.yml"), "utf8");
    expect(body).toMatch(/^\s{2}postgres:/m);
    expect(body).toMatch(/^\s{2}redis:/m);
    expect(body).not.toMatch(/^\s{2}minio:/m);
  });

  it("writes tier 3 compose with postgres + redis + minio", async () => {
    const dir = join(workDir, "t3");
    await writeComposeFile(dir, 3);
    const body = await readFile(join(dir, "docker-compose.yml"), "utf8");
    expect(body).toMatch(/^\s{2}postgres:/m);
    expect(body).toMatch(/^\s{2}redis:/m);
    expect(body).toMatch(/^\s{2}minio:/m);
  });

  it("creates the install directory if missing (recursive mkdir)", async () => {
    const nested = join(workDir, "does", "not", "yet", "exist");
    await writeComposeFile(nested, 1);
    const body = await readFile(join(nested, "docker-compose.yml"), "utf8");
    expect(body.length).toBeGreaterThan(0);
  });
});

describe("writeEnvFile", () => {
  it("writes the body verbatim to <dir>/.env", async () => {
    const body = "FOO=bar\nBAZ=qux\n";
    await writeEnvFile(workDir, body);
    const round = await readFile(join(workDir, ".env"), "utf8");
    expect(round).toBe(body);
  });

  it("writes with 0600 mode so backup tools can't pick up the secrets", async () => {
    // Windows ACLs don't map cleanly to Unix chmod bits — skip the
    // assertion rather than flaky-test on `runs-on: windows-latest`.
    if (platform() === "win32") return;
    await writeEnvFile(workDir, "BETTER_AUTH_SECRET=deadbeef\n");
    const s = await stat(join(workDir, ".env"));
     
    expect(s.mode & 0o777).toBe(0o600);
  });
});

describe("assertDockerAvailable", () => {
  it("resolves when a docker shim on PATH exits 0", async () => {
    // Windows: `spawn` on a plain file without .cmd/.ps1 extension behaves
    // differently. Skip — we exercise the happy path on every Linux/macOS
    // runner already.
    if (platform() === "win32") return;
    const shimDir = join(workDir, "shim-ok");
    await mkShim(shimDir, "docker", "#!/usr/bin/env bash\nexit 0\n");
    process.env.PATH = `${shimDir}:${originalPath}`;
    await assertDockerAvailable();
  });

  it("throws DockerMissingError when docker is not on PATH", async () => {
    // Point PATH at an empty dir → `docker` resolves to nothing, spawn
    // emits ENOENT → runCommand returns ok:false → assertDockerAvailable
    // throws. Works cross-platform because an empty dir shadows system PATH.
    const emptyDir = join(workDir, "empty");
    await mkShim(emptyDir, ".keep", "");
    process.env.PATH = emptyDir;
    await expect(assertDockerAvailable()).rejects.toBeInstanceOf(DockerMissingError);
  });

  it("throws DockerMissingError when docker is present but the daemon is unreachable", async () => {
    if (platform() === "win32") return;
    const shimDir = join(workDir, "shim-daemon-down");
    // Mirrors the real `docker info` output when the daemon is down
    // (non-zero exit, stderr noise). assertDockerAvailable only cares
    // about the exit code.
    await mkShim(shimDir, "docker", "#!/usr/bin/env bash\necho daemon unreachable >&2\nexit 1\n");
    process.env.PATH = `${shimDir}:${originalPath}`;
    await expect(assertDockerAvailable()).rejects.toBeInstanceOf(DockerMissingError);
  });
});

describe("waitForAppstrate", () => {
  it("resolves when the app URL returns 2xx", async () => {
    globalThis.fetch = (async () => new Response("", { status: 200 })) as typeof fetch;
    await waitForAppstrate("http://127.0.0.1:65535", 500);
  });

  it("throws a helpful message when the timeout elapses", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    await expect(waitForAppstrate("http://127.0.0.1:65535", 50)).rejects.toThrow(
      /did not become healthy/i,
    );
  });
});

describe("DockerMissingError", () => {
  it("carries a user-facing install hint", () => {
    const err = new DockerMissingError();
    expect(err.name).toBe("DockerMissingError");
    expect(err.message).toMatch(/Docker Desktop/i);
    expect(err.message).toMatch(/Tier 0/i);
  });
});

async function mkShim(dir: string, name: string, body: string): Promise<void> {
  await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, body);
  if (body.length > 0) await chmod(path, 0o755);
}
