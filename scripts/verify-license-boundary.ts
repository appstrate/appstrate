// SPDX-License-Identifier: Apache-2.0
/// <reference types="bun" />

/**
 * Verify that every source file states the licence that actually governs it:
 *   packages/module-ee/**  →  // SPDX-License-Identifier: LicenseRef-Appstrate-Commercial
 *   everything else        →  // SPDX-License-Identifier: Apache-2.0
 * within the first 3 lines, so a shebang or `/// <reference>` may precede it. A
 * file on the wrong side is a licensing defect no compiler, linter or test can
 * see. THE TRAP: the set comes from `git ls-files`, so a file not yet `git
 * add`ed passes here and fails the moment it is staged.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SOURCE_GLOBS, trackedFiles } from "./lib/tracked-files.ts";

const REPO_ROOT = join(import.meta.dir, "..");

const HEADER_LINES = 3;

const COMMERCIAL_PREFIX = "packages/module-ee/";

export type ExpectedLicense = "Apache-2.0" | "LicenseRef-Appstrate-Commercial";

// Exempt: a hand-added header is erased on the next regeneration and
// `verify:api-types` then fails on the diff. Explicit paths, never a directory.
const GENERATED_ALLOWLIST: readonly string[] = [
  // Emitted by `scripts/generate-api-types.ts`; checked by `verify:api-types`.
  "apps/web/src/api/schema.d.ts",
];

export function expectedLicenseFor(path: string): ExpectedLicense {
  return path.startsWith(COMMERCIAL_PREFIX) ? "LicenseRef-Appstrate-Commercial" : "Apache-2.0";
}

/** The violation `path` commits given the top of its content, or `null`. Pure. */
export function checkLicenseHeader(path: string, lines: readonly string[]): string | null {
  const expected = expectedLicenseFor(path);
  const header = lines
    .slice(0, HEADER_LINES)
    .find((line) => line.includes("SPDX-License-Identifier"));

  if (header === undefined) {
    return `${path} — no SPDX header in the first ${HEADER_LINES} lines. Add \`// SPDX-License-Identifier: ${expected}\`.`;
  }
  if (header.trim() !== `// SPDX-License-Identifier: ${expected}`) {
    return `${path} — declares \`${header.trim()}\`, expected \`// SPDX-License-Identifier: ${expected}\`.`;
  }
  return null;
}

/**
 * Everything eslint has an opinion about, plus the two TypeScript module
 * extensions its config omits. Not `.sql`/`.json`/`.md`: applied migrations are
 * immutable, and the LICENSE files at the two roots cover data and prose.
 */
export const LICENSED_GLOBS: readonly string[] = [...SOURCE_GLOBS, "*.mts", "*.cts"];

if (import.meta.main) {
  const tracked = trackedFiles(LICENSED_GLOBS, "source file", "skip");
  const files = tracked.filter((path) => !GENERATED_ALLOWLIST.includes(path));

  const problems: string[] = [];

  // An exemption for a file that no longer exists is one nobody re-reads — the
  // shape that let the `verify-openapi.ts` allowlists fill with dead entries.
  for (const path of GENERATED_ALLOWLIST) {
    if (!tracked.includes(path)) {
      problems.push(
        `GENERATED_ALLOWLIST names \`${path}\`, which is not tracked. Delete the entry.`,
      );
    }
  }

  let apache = 0;
  let commercial = 0;

  for (const path of files) {
    const lines = readFileSync(join(REPO_ROOT, path), "utf8").split("\n", HEADER_LINES);
    const problem = checkLicenseHeader(path, lines);
    if (problem) {
      problems.push(problem);
      continue;
    }
    if (expectedLicenseFor(path) === "Apache-2.0") apache++;
    else commercial++;
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`❌ ${problem}`);
    console.error(
      `\n${problems.length} file(s) with a wrong or missing licence header. ` +
        `The repository is Apache-2.0 except \`${COMMERCIAL_PREFIX}\`, which is under the ` +
        `commercial licence in that directory.\n` +
        `Note: this gate reads \`git ls-files\`, so a file you have not \`git add\`ed yet is ` +
        `not listed above — stage it and re-run.`,
    );
    process.exit(1);
  }

  console.log(
    `✅ licence boundary clean — ${files.length} files checked, ${apache} Apache-2.0, ` +
      `${commercial} commercial, ${GENERATED_ALLOWLIST.length} generated file(s) exempt.`,
  );
}
