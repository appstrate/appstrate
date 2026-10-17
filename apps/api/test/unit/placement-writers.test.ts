// SPDX-License-Identifier: Apache-2.0

/**
 * Who WRITES a placement (RBAC spec §6.10, R5) — read off the source tree.
 *
 * `space_packages` has one creator outside a package's home, `placePackage`,
 * and every other insert sits inside the placement rule (home, system package,
 * a default-on opt-out). The route tests prove each door's behaviour; this pins
 * the SET of writers, so a new `insert(spacePackages)` anywhere must come here
 * and say which rule it lives under. The retired `package_shares` table is
 * named only by its schema declaration and the boot guard refusing to start
 * while it still holds a row.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { grepFiles, REPO_ROOT } from "../helpers/source-grep.ts";

const INSERT = ".insert(spacePackages)";
const WRITER_FILE = "apps/api/src/services/space-packages.ts";

/** `apps/api/src` and every `packages/<pkg>/src` — the application source. */
const SOURCE_ROOTS = [
  "apps/api/src",
  ...readdirSync(join(REPO_ROOT, "packages"))
    .map((pkg) => `packages/${pkg}/src`)
    .filter((root) => statSync(join(REPO_ROOT, root), { throwIfNoEntry: false })?.isDirectory()),
];

/** Source files only: a test seeding a row is not a door. */
const nonTest = (files: string[]) => files.filter((file) => !file.includes("/test/"));

describe("space_packages writers", () => {
  it("are all in services/space-packages.ts", () => {
    const files = nonTest(grepFiles(INSERT, SOURCE_ROOTS, { expectMatch: [WRITER_FILE] }));
    expect(files).toEqual([WRITER_FILE]);
  });

  it("are exactly these four functions, and only placePackage places outside the home", () => {
    // `placePackage` is the share door. The other three create a row only where
    // the package is already placed without one: `activatePackageWithin` at
    // home or for a system package, `deactivatePackage` for the opt-out of a
    // default-on package, `updateSpacePackage` with the default's `enabled`.
    const lines = readFileSync(join(REPO_ROOT, WRITER_FILE), "utf8").split("\n");
    const writers: string[] = [];
    let current = "";
    for (const line of lines) {
      const fn = /^(?:export )?(?:async )?function (\w+)/.exec(line);
      if (fn) current = fn[1]!;
      if (line.includes(INSERT)) writers.push(current);
    }
    expect(writers.sort()).toEqual([
      "activatePackageWithin",
      "deactivatePackage",
      "placePackage",
      "updateSpacePackage",
    ]);
  });
});

describe("the retired package_shares table", () => {
  const ALLOWED = ["apps/api/src/lib/boot.ts", "packages/db/src/schema/packages.ts"];

  it("is named only by its schema declaration and the boot guard", () => {
    const named = [
      ...grepFiles("packageShares", SOURCE_ROOTS, {
        expectMatch: ["packages/db/src/schema/packages.ts"],
      }),
      ...grepFiles("package_shares", SOURCE_ROOTS, { expectMatch: ["apps/api/src/lib/boot.ts"] }),
    ];
    expect([...new Set(named)].sort()).toEqual(ALLOWED);
  });
});
