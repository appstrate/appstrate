// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `appstrate start / stop / restart / logs /
 * status / uninstall` (issue #343).
 *
 * Strategy: every test installs a `docker` shim on PATH that records
 * its argv to a file, then we assert each lifecycle command invoked
 * `docker compose --project-name <name from sidecar> <verb>` exactly.
 * No real Docker required — the shim is the spec for what the
 * commands MUST emit.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { writeProjectFile } from "../src/lib/install/project.ts";
import {
  startCommand,
  stopCommand,
  restartCommand,
  logsCommand,
  statusCommand,
  uninstallCommand,
} from "../src/commands/lifecycle.ts";

const originalPath = process.env.PATH;
const originalYesEnv = process.env.APPSTRATE_YES;
let workDir: string; // tempdir holding the install + the docker shim subdir
let installDir: string; // <workDir>/install
let shimDir: string; // <workDir>/shim — exposes a fake `docker`
let argvFile: string; // shim writes one line per invocation
const PROJECT_NAME = "appstrate-test-deadbeef";

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "appstrate-cli-lifecycle-"));
  installDir = join(workDir, "install");
  shimDir = join(workDir, "shim");
  argvFile = join(workDir, "argv.log");
  await mkdir(installDir, { recursive: true });
  await mkdir(shimDir, { recursive: true });
  await writeProjectFile(installDir, PROJECT_NAME);
  await installDockerShim();
  process.env.PATH = `${shimDir}:${originalPath}`;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalYesEnv === undefined) delete process.env.APPSTRATE_YES;
  else process.env.APPSTRATE_YES = originalYesEnv;
  await rm(workDir, { recursive: true, force: true });
});

/**
 * Build a minimal `docker` shim that:
 *   1. Records its full argv (newline-joined) to `argvFile` so tests
 *      can assert on the exact `compose --project-name … <verb>` line.
 *   2. Exits 0 — every lifecycle test exercises the happy path; we
 *      have a separate test below for the non-zero failure shape.
 */
async function installDockerShim(exitCode = 0): Promise<void> {
  const path = join(shimDir, "docker");
  await writeFile(
    path,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvFile)}\nexit ${exitCode}\n`,
  );
  await chmod(path, 0o755);
}

async function readArgv(): Promise<string[]> {
  // The shim appends one line per invocation. Trim trailing blank.
  const raw = await readFile(argvFile, "utf8").catch(() => "");
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe("appstrate start", () => {
  it("invokes `docker compose --project-name <sidecar> up -d`", async () => {
    if (platform() === "win32") return;
    await startCommand({ dir: installDir });
    const argv = await readArgv();
    expect(argv).toEqual([`compose --project-name ${PROJECT_NAME} up -d`]);
  });
});

describe("appstrate stop", () => {
  it("invokes `docker compose --project-name <sidecar> stop`", async () => {
    if (platform() === "win32") return;
    await stopCommand({ dir: installDir });
    const argv = await readArgv();
    expect(argv).toEqual([`compose --project-name ${PROJECT_NAME} stop`]);
  });
});

describe("appstrate restart", () => {
  it("invokes `docker compose --project-name <sidecar> restart`", async () => {
    if (platform() === "win32") return;
    await restartCommand({ dir: installDir });
    const argv = await readArgv();
    expect(argv).toEqual([`compose --project-name ${PROJECT_NAME} restart`]);
  });
});

describe("appstrate logs", () => {
  it("invokes `docker compose --project-name <sidecar> logs` by default", async () => {
    if (platform() === "win32") return;
    await logsCommand({ dir: installDir });
    const argv = await readArgv();
    expect(argv).toEqual([`compose --project-name ${PROJECT_NAME} logs`]);
  });

  it("appends `-f` when --follow is set", async () => {
    if (platform() === "win32") return;
    await logsCommand({ dir: installDir, follow: true });
    const argv = await readArgv();
    expect(argv).toEqual([`compose --project-name ${PROJECT_NAME} logs -f`]);
  });

  it("forwards the optional service-name positional", async () => {
    if (platform() === "win32") return;
    await logsCommand({ dir: installDir, follow: true, service: "postgres" });
    const argv = await readArgv();
    expect(argv).toEqual([`compose --project-name ${PROJECT_NAME} logs -f postgres`]);
  });
});

describe("appstrate status", () => {
  it("invokes `docker compose --project-name <sidecar> ps`", async () => {
    if (platform() === "win32") return;
    await statusCommand({ dir: installDir });
    const argv = await readArgv();
    expect(argv).toEqual([`compose --project-name ${PROJECT_NAME} ps`]);
  });
});

describe("appstrate uninstall", () => {
  it("default invokes `docker compose --project-name <sidecar> down` (no -v)", async () => {
    if (platform() === "win32") return;
    await uninstallCommand({ dir: installDir });
    const argv = await readArgv();
    expect(argv).toEqual([`compose --project-name ${PROJECT_NAME} down`]);
    // The install dir MUST still exist — default uninstall preserves data.
    const dirStat = await stat(installDir);
    expect(dirStat.isDirectory()).toBe(true);
  });

  it("--purge --yes invokes `down -v` AND removes the install directory", async () => {
    if (platform() === "win32") return;
    await uninstallCommand({ dir: installDir, purge: true, yes: true });
    const argv = await readArgv();
    expect(argv).toEqual([`compose --project-name ${PROJECT_NAME} down -v`]);
    // Dir gone — destructive flow ran end-to-end.
    await expect(stat(installDir)).rejects.toThrow();
  });

  it("--purge respects APPSTRATE_YES=1 as the auto-confirm switch", async () => {
    if (platform() === "win32") return;
    process.env.APPSTRATE_YES = "1";
    await uninstallCommand({ dir: installDir, purge: true });
    const argv = await readArgv();
    expect(argv).toEqual([`compose --project-name ${PROJECT_NAME} down -v`]);
    await expect(stat(installDir)).rejects.toThrow();
  });

  it("--purge without --yes refuses to run when stdin is not a TTY", async () => {
    if (platform() === "win32") return;
    // bun:test runs with a non-TTY stdin, so this path is exercised
    // automatically — confirm we get a clear error rather than a hang.
    delete process.env.APPSTRATE_YES;
    await expect(uninstallCommand({ dir: installDir, purge: true })).rejects.toThrow(
      /destructive.*confirmation/i,
    );
    // Critically: the dir must STILL exist — the guard fires before
    // any side-effect.
    const dirStat = await stat(installDir);
    expect(dirStat.isDirectory()).toBe(true);
  });

  it("non-zero `docker compose down` surfaces as a thrown Error", async () => {
    if (platform() === "win32") return;
    // Replace the shim with one that exits non-zero.
    await installDockerShim(2);
    await expect(uninstallCommand({ dir: installDir })).rejects.toThrow(
      /docker compose down failed with exit code 2/,
    );
    // Dir must remain — failure path doesn't accidentally rm-rf.
    const dirStat = await stat(installDir);
    expect(dirStat.isDirectory()).toBe(true);
  });
});

describe("missing sidecar (resolveInstall failure path)", () => {
  it("every lifecycle command rejects with InstallNotFoundError-shaped message when project.json is absent", async () => {
    if (platform() === "win32") return;
    const empty = join(workDir, "empty");
    await mkdir(empty, { recursive: true });
    for (const fn of [
      () => startCommand({ dir: empty }),
      () => stopCommand({ dir: empty }),
      () => restartCommand({ dir: empty }),
      () => logsCommand({ dir: empty }),
      () => statusCommand({ dir: empty }),
      () => uninstallCommand({ dir: empty }),
    ]) {
      await expect(fn()).rejects.toThrow(/No Appstrate install found/);
    }
  });
});
