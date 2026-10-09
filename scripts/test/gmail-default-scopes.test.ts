// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard (#1871): every connection of an auth requests its
 * `default_scopes`, so a write scope there makes every Gmail connection — a
 * read-only agent's included — able to write. Write access is declared by the
 * agents that need it. Reads the source manifests, located by name (a version
 * bump renames the directory); lives in `scripts/test/` for the reason
 * `github-git-mcp.test.ts` gives.
 */

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCES = join(import.meta.dir, "..", "system-packages");
const WRITE_SCOPES = ["send", "compose", "modify", "insert"].map(
  (s) => `https://www.googleapis.com/auth/gmail.${s}`,
);
const FULL_MAILBOX = "https://mail.google.com/";

function defaultScopesOf(prefix: RegExp): string[] {
  const dirs = readdirSync(SOURCES).filter((d) => prefix.test(d));
  if (dirs.length !== 1) throw new Error(`expected one source for ${prefix}, got [${dirs}]`);
  const manifest = JSON.parse(readFileSync(join(SOURCES, dirs[0]!, "manifest.json"), "utf8")) as {
    auths: Record<string, { default_scopes?: string[] }>;
  };
  return Object.values(manifest.auths).flatMap((auth) => auth.default_scopes ?? []);
}

describe("Gmail default_scopes grant no write access", () => {
  for (const [name, prefix] of [
    ["@appstrate/gmail", /^integration-gmail-\d+\.\d+\.\d+$/],
    ["@appstrate/gmail-mcp", /^integration-gmail-mcp-\d+\.\d+\.\d+$/],
  ] as const) {
    it(name, () => {
      const scopes = defaultScopesOf(prefix);
      expect(scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
      for (const write of [...WRITE_SCOPES, FULL_MAILBOX]) expect(scopes).not.toContain(write);
    });
  }
});
