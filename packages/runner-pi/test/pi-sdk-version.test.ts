// SPDX-License-Identifier: Apache-2.0

/**
 * `PI_SDK_VERSION` is what an aliased run's container tells the sidecar it was
 * built against. A hardcoded string rots, and a repo whose two images pinned
 * DIFFERENT pi-ai versions would make the header lie about the pair. Both are
 * pinned here: every manifest declaring pi-ai agrees, and agrees with the
 * constant.
 */

import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { expect, it } from "bun:test";
import { PI_SDK_VERSION } from "../src/provider-map.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SKIP = new Set(["node_modules", ".git", ".turbo", ".worktrees", "dist", "coverage"]);
const PIN = "@earendil-works/pi-ai";
const BLOCKS = ["dependencies", "devDependencies", "peerDependencies"] as const;

async function* manifests(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) yield* manifests(join(dir, entry.name));
    } else if (entry.name === "package.json") {
      yield join(dir, entry.name);
    }
  }
}

it("pins `@earendil-works/pi-ai` to PI_SDK_VERSION in every manifest declaring it", async () => {
  const declared: Record<string, string> = {};
  for await (const file of manifests(REPO_ROOT)) {
    const pkg = (await Bun.file(file).json()) as Record<string, Record<string, string>>;
    for (const block of BLOCKS) {
      const version = pkg[block]?.[PIN];
      if (version) declared[`${relative(REPO_ROOT, file)} (${block})`] = version;
    }
  }
  // Walked, not listed: a new package pinning pi-ai joins this guard the day it
  // is added rather than the day someone remembers to extend an array.
  expect(Object.keys(declared).length).toBeGreaterThanOrEqual(6);
  // One assertion, and the diff names which manifest disagrees.
  expect(declared).toEqual(
    Object.fromEntries(Object.keys(declared).map((key) => [key, PI_SDK_VERSION])),
  );
});
