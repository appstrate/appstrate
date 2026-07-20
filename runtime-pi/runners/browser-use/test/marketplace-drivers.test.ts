// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../../..");

async function pythonAvailable(): Promise<boolean> {
  try {
    const process = Bun.spawn(["python3", "--version"], { stdout: "ignore", stderr: "ignore" });
    return (await process.exited) === 0;
  } catch {
    return false;
  }
}

const HAS_PYTHON = await pythonAvailable();
const runPythonTest: typeof it = HAS_PYTHON ? it : (it.skip as unknown as typeof it);

runPythonTest("executes the real Leboncoin and Vinted Browser Use driver tests", async () => {
  const runnerRoot = join(REPO_ROOT, "runtime-pi/runners/browser-use");
  const process = Bun.spawn(
    [
      "python3",
      "-m",
      "unittest",
      "discover",
      "-s",
      join(runnerRoot, "tests"),
      "-p",
      "test_marketplace_drivers.py",
      "-v",
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...processEnv(),
        APPSTRATE_BROWSER_DRIVER_SOURCE_ROOT: join(REPO_ROOT, "scripts/system-packages"),
        PYTHONPATH: runnerRoot,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect(`${stdout}\n${stderr}`).not.toContain("skipped");
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
});

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
