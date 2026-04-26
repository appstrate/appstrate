// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `installCommand.resolveProjectName`.
 *
 * The two-way origin dispatch (`sidecar` / `derived`) keeps Compose
 * project namespaces under our control: an install with a recorded
 * sidecar always answers to that exact name; a fresh dir gets a
 * deterministic derived one.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProjectName } from "../../src/commands/install.ts";
import { writeProjectFile } from "../../src/lib/install/project.ts";

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
    const resolved = await resolveProjectName(workDir);
    expect(resolved.name).toBe("appstrate-recorded-deadbeef");
    expect(resolved.origin).toBe("sidecar");
  });

  it("derives a fresh name for a dir without a sidecar file", async () => {
    const resolved = await resolveProjectName(workDir);
    expect(resolved.origin).toBe("derived");
    // `appstrate-<slug>-<8 hex>` shape — the slug is the basename of
    // the temp dir, which `mkdtemp` suffixes with random hex.
    expect(resolved.name).toMatch(/^appstrate-[a-z0-9_-]+-[0-9a-f]{8}$/);
  });
});
