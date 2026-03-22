/**
 * Runner for isolated service tests.
 *
 * Bun's mock.module is process-global: when route tests mock a service module,
 * service tests in the same process can't import the real module.
 * This runner spawns each service test in a subprocess to avoid contamination.
 *
 * Test files use .unit.ts extension so bun test doesn't auto-discover them.
 */

import { describe, test, expect } from "bun:test";
import { resolve } from "path";

const testFiles = [
  "applications.unit.ts",
  "api-keys.unit.ts",
  "cross-app-isolation.unit.ts",
  "connection-profiles.unit.ts",
];

describe("isolated service tests", () => {
  for (const file of testFiles) {
    test(file.replace(".unit.ts", ""), async () => {
      const filePath = resolve(import.meta.dir, file);
      const proc = Bun.spawn(["bun", "test", filePath], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: resolve(import.meta.dir, "../../.."),
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        const stdout = await new Response(proc.stdout).text();
        throw new Error(`${file} failed (exit ${exitCode}):\n${stdout}\n${stderr}`);
      }
    }, 30_000);
  }
});
