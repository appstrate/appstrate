// SPDX-License-Identifier: Apache-2.0

/**
 * The `code sync` command suites' harness: a throw-away config, data and
 * `HOME` (so `~/.agents/skills` and `~/.claude/skills` land in a tmpdir), a
 * fake keyring and a logged-in profile pinned to `spaceId`. It registers its
 * own hooks, so call it once at a suite's top level.
 */

import { afterEach, beforeEach } from "bun:test";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDataDir } from "../../src/lib/config.ts";
import {
  installFakeKeyring,
  seedLoggedInProfile,
  useTempConfigHome,
  type FakeKeyringInstall,
} from "./auth-fixture.ts";

export function useSyncHarness(prefix: string, spaceId: string): { home: () => string } {
  const configHome = useTempConfigHome(`${prefix}-cfg-`);
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.HOME;
  const originalDataHome = process.env.XDG_DATA_HOME;
  let keyring: FakeKeyringInstall;
  let home = "";
  let dataHome = "";

  beforeEach(async () => {
    await configHome.setup();
    keyring = installFakeKeyring();
    home = await mkdtemp(join(tmpdir(), `${prefix}-home-`));
    dataHome = await mkdtemp(join(tmpdir(), `${prefix}-data-`));
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = dataHome;
    await seedLoggedInProfile("default", { orgId: "org_1", spaceId });
  });

  afterEach(async () => {
    keyring.restore();
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    await configHome.teardown();
    await rm(home, { recursive: true, force: true });
    await rm(dataHome, { recursive: true, force: true });
  });

  return { home: () => home };
}

export const pluginRoot = (): string => join(getDataDir(), "claude-plugin");

export async function readText(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

/** Files and directories alike — `readdir` alone would say "no" to a file. */
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Recursive path → text snapshot, for the determinism assertions. */
export async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else out[rel] = await readText(join(dir, entry.name));
    }
  };
  await walk(root, "");
  return out;
}
