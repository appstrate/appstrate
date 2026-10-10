// SPDX-License-Identifier: Apache-2.0

/**
 * The unread-key boot warning, held against the repository itself: the shipped
 * examples and the module schemas must never trigger it, and every key the
 * platform source reads must count as read. A finding here means either the
 * warning would fire on a clean install, or a read was added without the key
 * being registered anywhere the warning can see.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { envSchema, findUnreadEnvKeys } from "../../packages/env/src/index.ts";
import { SIDECAR_OPERATOR_ENV_KEYS } from "../../packages/runner-pi/src/index.ts";
import { moduleEnvSchemas } from "../lib/module-env-schemas.ts";
import { trackedFiles } from "../lib/tracked-files.ts";
import { readEnvExampleVars } from "../verify-env-docs.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Mirrors `platformReadEnvKeys()` in apps/api/src/lib/unread-env-keys.ts. The
 * API module is not imported here because it constructs the platform logger,
 * which reads the validated env at import time.
 */
const READ: ReadonlySet<string> = new Set([
  ...Object.keys(envSchema.shape),
  ...SIDECAR_OPERATOR_ENV_KEYS,
]);

const EXAMPLES = [".env.example", "deploy/.env.example", "examples/self-hosting/.env.example"];

const PROCESS_ENV_READ = /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[["']([A-Z][A-Z0-9_]*)["']\])/g;

describe("unread-env-keys over this repository", () => {
  it.each(EXAMPLES)("%s triggers no unread-key finding", (relative) => {
    const content = readFileSync(join(REPO_ROOT, relative), "utf-8");
    const unread = findUnreadEnvKeys(readEnvExampleVars(content), READ);
    expect(unread, "a shipped example would trigger the boot warning").toEqual([]);
  });

  it("no module schema key falls under a platform namespace unread", async () => {
    const modules: { module: string; key: string }[] = [];
    for (const schema of (await moduleEnvSchemas(REPO_ROOT)).schemas) {
      for (const key of Object.keys(schema.shape)) modules.push({ module: schema.id, key });
    }
    expect(modules.length).toBeGreaterThan(0);
    const findings = modules.flatMap(({ module, key }) =>
      findUnreadEnvKeys([key], READ).map((unread) => `${module}: ${unread}`),
    );
    expect(findings, "a module key under a platform namespace").toEqual([]);
  });

  it("every process.env read in platform source is a read key", () => {
    const files = trackedFiles(
      ["apps/api/src/**/*.ts", "packages/*/src/**/*.ts"],
      "platform source",
      "fail",
    ).filter((file) => !file.includes("/test/") && !file.includes("/scripts/"));
    const reads: { file: string; key: string }[] = [];
    for (const file of files) {
      const content = readFileSync(join(REPO_ROOT, file), "utf-8");
      for (const match of content.matchAll(PROCESS_ENV_READ)) {
        reads.push({ file, key: (match[1] ?? match[2])! });
      }
    }
    expect(reads.length, "no process.env reads found: the scan is vacuous").toBeGreaterThan(0);
    const findings = reads.flatMap(({ file, key }) =>
      findUnreadEnvKeys([key], READ).map((unread) => `${file}: ${unread}`),
    );
    expect(findings, "a platform read whose key is not registered as read").toEqual([]);
  });
});
