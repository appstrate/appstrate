// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the unified running-stack report (`lib/install/report.ts`)
 * shared by `appstrate install / start / restart`.
 *
 * The healthcheck-gated `reportRunning` needs a live server, so it is
 * covered by the lifecycle integration tests; here we pin the pure
 * string + the `.env`-derived URL resolution (including the
 * skip-on-unreadable contract).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appUrlForPort, runningBanner, resolveRunningUrls } from "../src/lib/install/report.ts";
import { defaultInstallDir } from "../src/lib/install/project.ts";

describe("appUrlForPort", () => {
  it("emits http://localhost:<port> for a normal port", () => {
    expect(appUrlForPort(3001)).toBe("http://localhost:3001");
  });

  it("elides the :80 suffix so the URL is canonical", () => {
    expect(appUrlForPort(80)).toBe("http://localhost");
  });
});

describe("runningBanner", () => {
  it("omits the --dir hint for the default install dir", () => {
    const banner = runningBanner({
      appUrl: "http://localhost:3001",
      projectName: "appstrate-appstrate-a5f39ee4",
      dir: defaultInstallDir(),
    });
    expect(banner).toContain("Appstrate is running at http://localhost:3001.");
    expect(banner).toContain("  appstrate logs -f\n");
    expect(banner).toContain("  appstrate stop\n");
    expect(banner).toContain("  appstrate uninstall\n");
    expect(banner).toContain(
      "docker compose --project-name appstrate-appstrate-a5f39ee4 <verb> from",
    );
    // No `--dir` flag threaded through the hints for the default path.
    expect(banner).not.toContain("--dir");
  });

  it("appends the --dir hint for a non-default install dir", () => {
    const dir = "/opt/appstrate";
    const banner = runningBanner({
      appUrl: "https://appstrate.example.com",
      projectName: "appstrate-appstrate-deadbeef",
      dir,
    });
    expect(banner).toContain(`  appstrate logs -f --dir ${dir}\n`);
    expect(banner).toContain(`  appstrate stop --dir ${dir}\n`);
    expect(banner).toContain(`  appstrate uninstall --dir ${dir}`);
    expect(banner).toContain("Appstrate is running at https://appstrate.example.com.");
  });
});

describe("resolveRunningUrls", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "appstrate-report-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when .env is missing (banner is skipped, not guessed)", async () => {
    expect(await resolveRunningUrls(dir)).toBeNull();
  });

  it("derives both URLs from PORT when APP_URL is absent", async () => {
    await writeFile(join(dir, ".env"), "PORT=3005\n");
    expect(await resolveRunningUrls(dir)).toEqual({
      appUrl: "http://localhost:3005",
      healthUrl: "http://localhost:3005",
    });
  });

  it("uses APP_URL for display but keeps the healthcheck on loopback:PORT", async () => {
    await writeFile(join(dir, ".env"), "PORT=8080\nAPP_URL=https://appstrate.example.com\n");
    expect(await resolveRunningUrls(dir)).toEqual({
      appUrl: "https://appstrate.example.com",
      healthUrl: "http://localhost:8080",
    });
  });

  it("falls back to port 3000 when PORT is unset", async () => {
    await writeFile(join(dir, ".env"), "APP_URL=http://localhost:3000\n");
    expect(await resolveRunningUrls(dir)).toEqual({
      appUrl: "http://localhost:3000",
      healthUrl: "http://localhost:3000",
    });
  });
});
