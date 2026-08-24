// SPDX-License-Identifier: Apache-2.0

/**
 * Enumerate the named exports of a `src` tree, by reading the source.
 *
 * Shared by `export-surface.test.ts` and by the baseline regeneration command
 * documented there, so the check and the snapshot can never disagree on what
 * counts as an export.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** `name -> the file it is exported from`, relative to `root`. */
export async function exportedNames(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};

  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "test") continue;
        await walk(join(dir, entry.name), rel);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const src = await readFile(join(dir, entry.name), "utf8");

      // `export const|function|class|interface|type|enum NAME`
      for (const m of src.matchAll(
        /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm,
      )) {
        found[m[1]!] ??= rel;
      }

      // `export { A, B as C };` — a re-export LIST, not `export … from "…"`,
      // whose source module already contributed the name. `[^}]` cannot leave
      // its own statement, unlike a lazy any-character class.
      for (const m of src.matchAll(/^export\s*\{([^}]*)\}\s*;/gm)) {
        for (const raw of (m[1] ?? "").split(",")) {
          const spec = raw.trim();
          if (!spec) continue;
          const name = (spec.split(/\s+as\s+/).pop() ?? "").replace(/^type\s+/, "").trim();
          if (name && name !== "default") found[name] ??= rel;
        }
      }
    }
  };

  await walk(root, "");
  return found;
}
