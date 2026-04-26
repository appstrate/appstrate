// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `lib/install/project.ts` — Compose project-name
 * derivation + sidecar `.appstrate/project.json` persistence.
 *
 * Covers the regression the issue in #167 called out: two installs in
 * two directories must resolve to two different project names, and the
 * name a dir is bound to must survive re-runs via the sidecar file.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PROJECT_FILE_RELPATH,
  deriveProjectName,
  projectFilePath,
  readProjectFile,
  writeProjectFile,
} from "../../src/lib/install/project.ts";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "appstrate-cli-project-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("deriveProjectName", () => {
  it("produces a Compose-legal name shaped `appstrate-<slug>-<hash>`", () => {
    const name = deriveProjectName("/Users/alice/appstrate");
    // `appstrate-appstrate-<8 hex>` — the prefix is the literal CLI
    // brand, the slug mirrors the dir basename, the hash disambiguates.
    expect(name).toMatch(/^appstrate-appstrate-[0-9a-f]{8}$/);
  });

  it("includes an 8-char stable hash of the absolute path", () => {
    const a = deriveProjectName("/home/bob/work/appstrate");
    const b = deriveProjectName("/home/bob/work/appstrate");
    expect(a).toBe(b); // deterministic
  });

  it("disambiguates two installs that share a basename", () => {
    // This is the exact #167 scenario: ~/dev/appstrate and
    // ~/prod/appstrate must NOT collide to one project name.
    const dev = deriveProjectName("/home/bob/dev/appstrate");
    const prod = deriveProjectName("/home/bob/prod/appstrate");
    expect(dev).not.toBe(prod);
  });

  it("slugifies uppercase / spaces / special characters into a Compose-legal charset", () => {
    const name = deriveProjectName("/Users/alice/Projects/Appstrate — Dev");
    // Compose project names: [a-z0-9][a-z0-9_-]*. Our format also
    // reserves the `appstrate-` prefix + 8-hex suffix.
    expect(name).toMatch(/^appstrate-[a-z0-9][a-z0-9_-]*-[0-9a-f]{8}$/);
    // No raw uppercase / spaces bled through.
    expect(name).not.toMatch(/[A-Z ]/);
  });

  it("falls back to a sane slug when the basename is all punctuation", () => {
    // `basename("/home/bob/____")` is `____` → slugify strips to empty
    // → we must fall back to the `install` literal instead of emitting
    // an illegal `appstrate--<hash>` with a leading `-` in the slug.
    const name = deriveProjectName("/home/bob/____");
    expect(name).toMatch(/^appstrate-install-[0-9a-f]{8}$/);
  });

  it("caps the slug length so the project name stays under container-name limits", () => {
    const long = "/home/bob/" + "x".repeat(200);
    const name = deriveProjectName(long);
    // `appstrate-` (10) + slug (≤ 32) + `-` (1) + 8 = ≤ 51 chars.
    expect(name.length).toBeLessThanOrEqual(51);
  });
});

describe("readProjectFile / writeProjectFile", () => {
  it("round-trips: writing then reading yields the same projectName", async () => {
    await writeProjectFile(workDir, "appstrate-test-deadbeef");
    const read = await readProjectFile(workDir);
    expect(read).not.toBeNull();
    expect(read?.projectName).toBe("appstrate-test-deadbeef");
    expect(read?.version).toBe(1);
    // createdAt must be a valid ISO-8601 string.
    expect(() => new Date(read!.createdAt).toISOString()).not.toThrow();
  });

  it("returns null when the sidecar file doesn't exist (fresh install dir)", async () => {
    const read = await readProjectFile(workDir);
    expect(read).toBeNull();
  });

  it("writes the sidecar under `.appstrate/project.json` relative to dir", async () => {
    await writeProjectFile(workDir, "appstrate-foo-11111111");
    const onDisk = await readFile(join(workDir, PROJECT_FILE_RELPATH), "utf8");
    const parsed = JSON.parse(onDisk) as { projectName: string };
    expect(parsed.projectName).toBe("appstrate-foo-11111111");
  });

  it("treats a malformed sidecar as missing rather than throwing", async () => {
    // A user who hand-edits `.appstrate/project.json` into garbage
    // must not get a crashed CLI — they get a fresh derived name on
    // the next install.
    await mkdir(join(workDir, ".appstrate"), { recursive: true });
    await writeFile(projectFilePath(workDir), "{not valid json");
    const read = await readProjectFile(workDir);
    expect(read).toBeNull();
  });

  it("treats an unknown schema version as missing (safer than reading partial fields)", async () => {
    await mkdir(join(workDir, ".appstrate"), { recursive: true });
    await writeFile(
      projectFilePath(workDir),
      JSON.stringify({ version: 99, projectName: "x", createdAt: "2026-01-01T00:00:00Z" }),
    );
    const read = await readProjectFile(workDir);
    expect(read).toBeNull();
  });
});
