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

describe("PGlite client under bun --hot", () => {
  it("reuses the open instance when the module is re-evaluated", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pglite-hot-"));
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `const a = await import("${client}?reeval=1");
           const b = await import("${client}?reeval=2");
           const same = a.getPGliteClient() !== null && a.getPGliteClient() === b.getPGliteClient();
           await a.closeDb();
           process.stdout.write(String(same));`,
        ],
        // Empty rather than unset: Bun would load it back from `.env`.
        {
          env: { ...process.env, DATABASE_URL: "", PGLITE_DATA_DIR: dataDir },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ out, code, err: code === 0 ? "" : err }).toEqual({ out: "true", code: 0, err: "" });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
