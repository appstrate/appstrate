// SPDX-License-Identifier: Apache-2.0

/**
 * `bun --hot` re-evaluates the client module inside the same process; a second
 * PGlite on the data directory the first still holds corrupts it. A query
 * string makes Bun evaluate the module afresh, which is what a hot reload does.
 * The check runs in a child without `DATABASE_URL`, so every tier exercises the
 * embedded path.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const client = Bun.fileURLToPath(new URL("../src/client.ts", import.meta.url));

/** Runs `script` in a child against a fresh data directory; resolves to its stdout. */
async function runChild(script: string): Promise<{ out: string; code: number; err: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "pglite-hot-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", script], {
      // Empty rather than unset: Bun would load it back from `.env`.
      env: { ...process.env, DATABASE_URL: "", PGLITE_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
      // A child that never settles is the failure one of these cases exists
      // for; just under the 30 s test timeout so it is never left orphaned.
      timeout: 28_000,
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, code, err: code === 0 ? "" : err };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe("PGlite client under bun --hot", () => {
  it("reuses the open instance when the module is re-evaluated", async () => {
    const result = await runChild(
      `const a = await import("${client}?reeval=1");
       const b = await import("${client}?reeval=2");
       const same = a.getPGliteClient() !== null && a.getPGliteClient() === b.getPGliteClient();
       await a.closeDb();
       process.stdout.write(String(same));`,
    );
    expect(result).toEqual({ out: "true", code: 0, err: "" });
  }, 30_000);

  it("drops the previous evaluation's LISTEN handlers", async () => {
    const result = await runChild(
      `const heard = [];
       const a = await import("${client}?reeval=1");
       await a.listenClient.listen("hot", () => heard.push("old"));
       const b = await import("${client}?reeval=2");
       await b.listenClient.listen("hot", () => heard.push("new"));
       await b.getPGliteClient().query("NOTIFY hot, 'x'");
       await new Promise((r) => setTimeout(r, 200));
       await b.closeDb();
       process.stdout.write(heard.join(","));`,
    );
    expect(result).toEqual({ out: "new", code: 0, err: "" });
  }, 30_000);
});

describe("PGlite client shutdown", () => {
  it("serves a query already running, then closes", async () => {
    // The query owns both mutexes before `closeDb()` is called (it is one
    // macrotask ahead), so the close has to wait for it rather than tear the
    // module down underneath — which never settled.
    const result = await runChild(
      `const a = await import("${client}");
       const pg = a.getPGliteClient();
       await pg.waitReady;
       const pending = pg.query("select 42 as n").then((r) => r.rows[0].n, (e) => "refused: " + e);
       await new Promise((r) => setTimeout(r, 0));
       await a.closeDb();
       process.stdout.write("closed," + (await pending));`,
    );
    expect(result).toEqual({ out: "closed,42", code: 0, err: "" });
  }, 30_000);

  it("lets a transaction in flight commit before closing", async () => {
    // The close arrives between the transaction's two statements.
    const result = await runChild(
      `const a = await import("${client}");
       const pg = a.getPGliteClient();
       await pg.waitReady;
       await pg.exec("create table t (i int)");
       const order = [];
       const tx = pg.transaction(async (tx) => {
         await tx.query("insert into t values (1)");
         await new Promise((r) => setTimeout(r, 200));
         await tx.query("insert into t values (2)");
         const { rows } = await tx.query("select count(*)::int as n from t");
         order.push("tx:" + rows[0].n);
       }).catch((e) => order.push("tx failed: " + e));
       await new Promise((r) => setTimeout(r, 50));
       await a.closeDb();
       order.push("closed");
       await tx;
       process.stdout.write(order.join(","));`,
    );
    expect(result).toEqual({ out: "tx:2,closed", code: 0, err: "" });
  }, 30_000);
});
