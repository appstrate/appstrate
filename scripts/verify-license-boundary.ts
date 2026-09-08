// SPDX-License-Identifier: Apache-2.0
/// <reference types="bun" />

/**
 * Verify that every TypeScript file states the licence that actually governs
 * it.
 *
 * The repository is Apache-2.0 with one exception: `packages/module-ee/` is
 * source-available under the Appstrate Commercial Licence. That boundary is a
 * legal statement, and a file on the wrong side of it — a commercial file
 * carrying `Apache-2.0`, or an Apache-2.0 file moved into the commercial
 * directory and left unmarked — is a licensing defect that no compiler, linter
 * or test can see. Hence a gate.
 *
 *   packages/module-ee/**  →  // SPDX-License-Identifier: LicenseRef-Appstrate-Commercial
 *   everything else        →  // SPDX-License-Identifier: Apache-2.0
 *
 * within the first 3 lines, so a shebang or a `/// <reference>` may precede it.
 * `//` is the only accepted comment form: no tracked `.ts`/`.tsx` file uses
 * another, and accepting forms nothing writes would be a rule nothing tests.
 *
 * THE TRAP: the file set comes from `git ls-files`, so a new file that has not
 * been `git add`ed is invisible to this gate — it passes, and fails the moment
 * it is staged. That is the deliberate trade: an untracked scratch file must
 * not block `bun run check`. Stage your work before trusting a green run.
 *
 * Usage: bun scripts/verify-license-boundary.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { trackedFiles } from "./lib/tracked-files.ts";

const REPO_ROOT = join(import.meta.dir, "..");

/** How many lines from the top of a file the header may appear in. */
const HEADER_LINES = 3;

/** The directory the commercial licence covers, as a repo-relative prefix. */
const COMMERCIAL_PREFIX = "packages/module-ee/";

/** The two licences a file in this repository can be under. */
export type ExpectedLicense = "Apache-2.0" | "LicenseRef-Appstrate-Commercial";

/**
 * Generated files, exempt because their content is rewritten wholesale by a
 * generator that does not emit a header — a header added by hand here would be
 * erased on the next regeneration and `verify:api-types` would then fail on the
 * diff.
 *
 * Explicit paths only, never a directory: a wholesale exemption grows silently
 * as files are added beside the generated one.
 */
const GENERATED_ALLOWLIST: readonly string[] = [
  // Emitted by `scripts/generate-api-types.ts` (openapi-typescript) from
  // `apps/api/src/openapi/`; the file's own first line is `/* eslint-disable */`
  // followed by an AUTO-GENERATED banner. Checked by `verify:api-types`.
  "apps/web/src/api/schema.d.ts",
];

/** Which licence a path must declare. */
export function expectedLicenseFor(path: string): ExpectedLicense {
  return path.startsWith(COMMERCIAL_PREFIX) ? "LicenseRef-Appstrate-Commercial" : "Apache-2.0";
}

/**
 * The violation `path` commits given the top of its content, or `null`.
 *
 * Pure — `scripts/test/verify-license-boundary.test.ts` drives both sides of
 * the boundary from synthetic input, which is the only way to exercise the
 * commercial branch while `packages/module-ee/` does not exist yet.
 */
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

if (import.meta.main) {
  const tracked = trackedFiles(["*.ts", "*.tsx"], "TypeScript file", "skip");
  const files = tracked.filter((path) => !GENERATED_ALLOWLIST.includes(path));

  const problems: string[] = [];

  // An exemption for a file that no longer exists is an exemption nobody
  // re-reads — the shape that let the `verify-openapi.ts` allowlists fill with
  // dead entries.
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
