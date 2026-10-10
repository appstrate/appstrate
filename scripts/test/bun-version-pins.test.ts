// SPDX-License-Identifier: Apache-2.0

/**
 * One Bun version for the whole repo: the root package.json's `packageManager`.
 *
 * CI reads it directly (`.github/actions/bun-setup` → `bun-version-file`), but
 * the Docker images and the devcontainer cannot, so they carry a copy of it in
 * their `oven/bun:<version>-<variant>` refs. A bump that misses one copy ships
 * images built on a different Bun than CI tested. Floating-major refs
 * (`oven/bun:1-alpine`, the user runner image) name no version and are not pins.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { trackedIndexFiles } from "../lib/tracked-files.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
// `1.4` or `1.4.2` — a minor or patch pin; `oven/bun:1-alpine` does not match.
const BUN_PIN = /oven\/bun:(\d+\.\d+(?:\.\d+)?)/g;
/** Every image ref, whatever its shape: a tag, a digest, a `${VAR}`, `latest`… */
const BUN_REF = /oven\/bun[:@][^\s"'`]*/g;
const EXACT_PIN = /^oven\/bun:\d+\.\d+\.\d+(?:-[a-z]+)?$/;
/** The one floating ref: the user runner image follows Bun's major on purpose. */
const FLOATING = "runtime-pi/runners/bun/Dockerfile oven/bun:1-alpine";

const read = (file: string) => readFileSync(join(REPO_ROOT, file), "utf-8");

function packageManagerVersion(): string {
  const { packageManager } = JSON.parse(read("package.json")) as { packageManager?: string };
  const m = /^bun@(\d+\.\d+\.\d+)$/.exec(packageManager ?? "");
  if (!m) throw new Error(`package.json packageManager is not bun@X.Y.Z: ${packageManager}`);
  return m[1]!;
}

describe("Bun version pins", () => {
  const version = packageManagerVersion();
  const files = trackedIndexFiles(
    ["*Dockerfile*", ".devcontainer/devcontainer.json"],
    "Bun pin file",
  );
  const matches = (pattern: RegExp) =>
    files.flatMap((file) =>
      read(file)
        .split("\n")
        .flatMap((text, i) =>
          [...text.matchAll(pattern)].map((m) => ({ file, at: `${file}:${i + 1}`, m })),
        ),
    );
  const pins = matches(BUN_PIN).map(({ at, m }) => ({ at, pin: m[1]! }));

  it("finds the pins it guards", () => {
    const files = new Set(pins.map((p) => p.at.split(":")[0]));
    for (const file of [
      "Dockerfile",
      "runtime-pi/Dockerfile",
      "runtime-pi/sidecar/Dockerfile",
      ".devcontainer/devcontainer.json",
    ]) {
      expect(files).toContain(file);
    }
  });

  it("equal packageManager's version", () => {
    expect(pins.filter((p) => p.pin !== version).map((p) => `${p.at} ${p.pin}`)).toEqual([]);
  });

  it("pin every image ref exactly, the runner image's floating major aside", () => {
    const loose = matches(BUN_REF)
      .filter(({ file, m }) => !EXACT_PIN.test(m[0]) && `${file} ${m[0]}` !== FLOATING)
      .map(({ at, m }) => `${at} ${m[0]}`);
    expect(loose).toEqual([]);
  });

  it("is the floor `engines.bun` declares, which the test preload enforces", () => {
    const { engines } = JSON.parse(read("package.json")) as { engines?: { bun?: string } };
    expect(engines?.bun).toBe(`>=${version}`);
  });

  it("CI reads the version from package.json", () => {
    expect(read(".github/actions/bun-setup/action.yml")).toMatch(
      /^\s*bun-version-file: package\.json$/m,
    );
  });
});
