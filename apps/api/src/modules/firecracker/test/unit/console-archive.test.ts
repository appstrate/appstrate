// SPDX-License-Identifier: Apache-2.0

/**
 * Console retention + read tests (issue #819, phase 4) — the Firecracker
 * orchestrator's archive-on-teardown, prune, and console-read paths. No
 * KVM: the console is a plain file we author, host commands are faked, and
 * every assertion is about the on-disk archive + the read contract.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _resetFirecrackerEnvCacheForTesting } from "../../runner/host-env.ts";
import { FirecrackerOrchestrator } from "../../orchestrator.ts";
import { fakeHostExec } from "../helpers/fake-host-exec.ts";
import { readyOrchestrator as readyOrch } from "../helpers/orchestrator-fixture.ts";

function readyOrchestrator(): FirecrackerOrchestrator {
  return readyOrch(fakeHostExec().exec);
}

/** Private-method access, same Reflect precedent as the sibling lifecycle test. */
interface ArchiveInternals {
  consoleArchiveDir(): string;
  archiveConsole(runId: string, tail: string): Promise<void>;
  pruneConsoleArchive(dir: string): Promise<void>;
}
const internals = (orch: FirecrackerOrchestrator): ArchiveInternals =>
  orch as unknown as ArchiveInternals;

const ORIGINAL_DATA_DIR = process.env.FIRECRACKER_DATA_DIR;
const ORIGINAL_JAILER = process.env.FIRECRACKER_JAILER;
let rootDir: string;
let dataDir: string;
let archiveDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "fc-console-test-"));
  dataDir = join(rootDir, "runs");
  await mkdir(dataDir, { recursive: true });
  process.env.FIRECRACKER_DATA_DIR = dataDir;
  // Direct-spawn path: the archive behavior is jail-agnostic, and the
  // jail layout's AF_UNIX socket-length guard would trip on long macOS
  // tmpdirs (jail-mode shapes are covered in firecracker-orchestrator.test.ts).
  process.env.FIRECRACKER_JAILER = "off";
  _resetFirecrackerEnvCacheForTesting();
  archiveDir = join(resolve(dataDir), "..", "console-archive");
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

afterAll(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.FIRECRACKER_DATA_DIR;
  else process.env.FIRECRACKER_DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_JAILER === undefined) delete process.env.FIRECRACKER_JAILER;
  else process.env.FIRECRACKER_JAILER = ORIGINAL_JAILER;
  _resetFirecrackerEnvCacheForTesting();
});

describe("console archive-on-teardown", () => {
  it("archives the last 256 KiB of the console before the workspace is deleted", async () => {
    const orch = readyOrchestrator();
    const runId = "run_archive";
    const boundary = await orch.createIsolationBoundary(runId);

    // A console larger than the retained tail — only the last 256 KiB survives.
    const head = "H".repeat(300 * 1024);
    const tail = "T".repeat(256 * 1024);
    const consolePath = join(boundary.id, "console.log");
    await writeFile(consolePath, head + tail);

    await orch.removeIsolationBoundary(boundary);

    // Workspace (with console.log) is gone; the archived tail remains.
    expect(await Bun.file(consolePath).exists()).toBe(false);
    const archived = await Bun.file(join(archiveDir, `${runId}.log`)).text();
    expect(archived.length).toBe(256 * 1024);
    expect(archived).toBe(tail);
  });

  it("does not write an archive file for a run that never produced a console", async () => {
    const orch = readyOrchestrator();
    const boundary = await orch.createIsolationBoundary("run_no_console");
    await orch.removeIsolationBoundary(boundary);
    expect(await Bun.file(join(archiveDir, "run_no_console.log")).exists()).toBe(false);
  });

  it("prunes the archive to the 100 most recent files", async () => {
    const orch = readyOrchestrator();
    await mkdir(archiveDir, { recursive: true });

    // 105 archives with strictly increasing mtimes so "most recent" is total.
    for (let i = 0; i < 105; i++) {
      const name = `run_${String(i).padStart(3, "0")}.log`;
      const path = join(archiveDir, name);
      await writeFile(path, `c${i}`);
      const when = new Date(1_700_000_000_000 + i * 1000);
      await utimes(path, when, when);
    }

    await internals(orch).pruneConsoleArchive(archiveDir);

    const remaining = (await readdir(archiveDir)).filter((n) => n.endsWith(".log")).sort();
    expect(remaining.length).toBe(100);
    // Oldest five pruned, newest kept.
    expect(remaining).not.toContain("run_000.log");
    expect(remaining).not.toContain("run_004.log");
    expect(remaining).toContain("run_005.log");
    expect(remaining).toContain("run_104.log");
  });
});

describe("readConsole", () => {
  it("serves the live console while the workload exists", async () => {
    const orch = readyOrchestrator();
    const runId = "run_live_read";
    const boundary = await orch.createIsolationBoundary(runId);
    await writeFile(join(boundary.id, "console.log"), "live console output\n");

    const text = await orch.readConsole(runId, 64 * 1024);
    expect(text).toBe("live console output\n");
  });

  it("falls back to the archive after teardown", async () => {
    const orch = readyOrchestrator();
    await internals(orch).archiveConsole("run_gone", "archived tail\n");

    const text = await orch.readConsole("run_gone", 64 * 1024);
    expect(text).toBe("archived tail\n");
  });

  it("returns null when neither a live nor an archived console exists", async () => {
    const orch = readyOrchestrator();
    expect(await orch.readConsole("run_unknown", 1024)).toBeNull();
  });

  it("clamps an over-cap tail request down to the maximum", async () => {
    const orch = readyOrchestrator();
    const big = "X".repeat(300 * 1024);
    await internals(orch).archiveConsole("run_big", big);

    // Ask for far more than the cap — served at most 256 KiB.
    const text = await orch.readConsole("run_big", 10 * 1024 * 1024);
    expect(text?.length).toBe(256 * 1024);
  });
});
