// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `installCommand.resolveProjectName`.
 *
 * The three-way origin dispatch (`sidecar` / `legacy` / `derived`) is
 * what keeps pre-#167 installs unbroken: a dir with a compose file but
 * no sidecar MUST answer to the literal `appstrate` project name, so
 * an upgrade targets the user's currently-running containers rather
 * than spinning up a disjoint new stack with fresh secrets.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProjectName } from "../../src/commands/install.ts";
import { writeProjectFile, LEGACY_PROJECT_NAME } from "../../src/lib/install/project.ts";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "appstrate-cli-resolve-project-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("resolveProjectName", () => {
  it("returns the sidecar-recorded name when `.appstrate/project.json` is present (authoritative)", async () => {
    await writeProjectFile(workDir, "appstrate-recorded-deadbeef");
    // `hasLegacyCompose` would normally be true for an install that
    // has been running, but the sidecar must take precedence.
    const resolved = await resolveProjectName(workDir, true);
    expect(resolved.name).toBe("appstrate-recorded-deadbeef");
    expect(resolved.origin).toBe("sidecar");
  });

  it("falls back to the legacy `appstrate` name when a pre-#167 compose file exists without a sidecar", async () => {
    const resolved = await resolveProjectName(workDir, true);
    expect(resolved.name).toBe(LEGACY_PROJECT_NAME);
    expect(resolved.origin).toBe("legacy");
  });

  it("derives a fresh name for a truly empty dir (no sidecar, no compose)", async () => {
    const resolved = await resolveProjectName(workDir, false);
    expect(resolved.origin).toBe("derived");
    // `appstrate-<slug>-<8 hex>` shape — the slug is the basename of
    // the temp dir, which `mkdtemp` suffixes with random hex.
    expect(resolved.name).toMatch(/^appstrate-[a-z0-9_-]+-[0-9a-f]{8}$/);
  });
});
