// SPDX-License-Identifier: Apache-2.0

// The generic behaviour of the transitional boot refusal: the list's own invariants and the
// message assembled from injected entries. Each entry's predicate against a live database is
// exercised in its own test (scripts/test/00NN-*-boot-gate.test.ts, the 0011 integration test).

import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertNoPendingDataScripts,
  PENDING_DATA_SCRIPTS,
  type PendingDataScript,
} from "../../src/lib/boot-guards/pending-data-scripts.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");

const entry = (script: string, after: string, pending: number): PendingDataScript => ({
  script,
  after,
  pending: async () => pending,
  consequence: `${after} consequence.`,
  removeWhen: "never, in this test",
});

describe("PENDING_DATA_SCRIPTS", () => {
  it("names a script that exists, with a consequence and a removal condition", () => {
    expect(PENDING_DATA_SCRIPTS.length).toBeGreaterThan(0);
    for (const e of PENDING_DATA_SCRIPTS) {
      expect(existsSync(resolve(REPO_ROOT, e.script))).toBe(true);
      expect(e.after).toMatch(/^\d{4}$/);
      expect(e.consequence.trim()).not.toBe("");
      expect(e.removeWhen.trim()).not.toBe("");
    }
  });
});

describe("assertNoPendingDataScripts", () => {
  it("resolves when every entry reports nothing pending", async () => {
    const scripts = [
      entry("scripts/migration/a.ts", "0001", 0),
      entry("scripts/migration/b.sql", "0002", 0),
    ];
    expect(await assertNoPendingDataScripts(null, scripts)).toBeUndefined();
  });

  it("evaluates every entry and throws ONE error naming each pending script and count", async () => {
    const scripts = [
      entry("scripts/migration/a.ts", "0001", 3),
      entry("scripts/migration/ok.ts", "0002", 0),
      entry("scripts/migration/c.ts", "0003", 5),
    ];
    const err = await assertNoPendingDataScripts(null, scripts).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).not.toBeNull();
    expect(err!.message).toContain("scripts/migration/a.ts (after drizzle 0001): 3 pending");
    expect(err!.message).toContain("scripts/migration/c.ts (after drizzle 0003): 5 pending");
    expect(err!.message).toContain("0001 consequence.");
    expect(err!.message).toContain("0003 consequence.");
    expect(err!.message).not.toContain("ok.ts");
    expect(err!.message).toContain("Refusing to boot");
    expect(err!.message).toContain("then restart.");
  });

  it("words the command by database kind, and a .sql script as an apply", async () => {
    const scripts = [
      entry("scripts/migration/a.ts", "0001", 1),
      entry("scripts/migration/b.sql", "0002", 1),
    ];
    const external = await assertNoPendingDataScripts(null, scripts).catch((e: Error) => e.message);
    expect(external).toContain(
      "run `bun scripts/migration/a.ts` (dry run), then `bun scripts/migration/a.ts --apply`, with this DATABASE_URL",
    );
    expect(external).toContain("apply scripts/migration/b.sql to this database");

    const embedded = await assertNoPendingDataScripts("/srv/pglite", scripts).catch(
      (e: Error) => e.message,
    );
    expect(embedded).toContain(
      "run `PGLITE_DATA_DIR=/srv/pglite bun scripts/migration/a.ts` (dry run), then the same with `--apply`",
    );
    expect(embedded).toContain("while it is stopped");
    expect(embedded).toContain("apply scripts/migration/b.sql to this database");
  });

  it("passes the injected database to every predicate", async () => {
    const seen: unknown[] = [];
    const database = { execute: () => Promise.resolve([]) };
    const spy: PendingDataScript = {
      ...entry("scripts/migration/a.ts", "0001", 0),
      pending: async (d) => {
        seen.push(d);
        return 0;
      },
    };
    await assertNoPendingDataScripts(null, [spy], database);
    expect(seen).toEqual([database]);
  });
});
