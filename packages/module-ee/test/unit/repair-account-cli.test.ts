// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * `bun run repair:account` is run by an operator against a live deployment, so
 * its argument check must come before it reads the environment or opens a
 * connection. Spawned with the module's env stripped: a script that validated
 * later would fail on the missing `DATABASE_URL` instead of printing usage.
 */

import { describe, expect, it } from "bun:test";

const SCRIPT = new URL("../../src/scripts/repair-account.ts", import.meta.url).pathname;

const EE_ENV_KEYS = [
  "DATABASE_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_ID_STARTER",
  "STRIPE_PRICE_ID_PRO",
];

function envWithoutEeVars(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !EE_ENV_KEYS.includes(key)) env[key] = value;
  }
  return env;
}

describe("repair:account CLI", () => {
  it("exits 2 with its usage line when no arguments are given", async () => {
    const proc = Bun.spawn([process.execPath, "run", SCRIPT], {
      stdout: "pipe",
      stderr: "pipe",
      env: envWithoutEeVars(),
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).toBe(2);
    expect(stdout + stderr).toContain("usage: bun run repair:account -- <orgId> <ownerEmail>");
  });

  it("exits 2 when only the org id is given", async () => {
    const proc = Bun.spawn([process.execPath, "run", SCRIPT, "org-without-an-email"], {
      stdout: "pipe",
      stderr: "pipe",
      env: envWithoutEeVars(),
    });

    expect(await proc.exited).toBe(2);
  });
});
