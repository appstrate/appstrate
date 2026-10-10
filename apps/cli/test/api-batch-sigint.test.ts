// SPDX-License-Identifier: Apache-2.0

/**
 * Ctrl-C in the middle of `appstrate api --batch`, against the real process: the
 * shutdown coordinator (`lib/shutdown.ts`) calls `process.exit` as soon as its hooks
 * settle, before the batch has written its remaining lines. The batch's hook holds that
 * exit so the command ends through `CommandExit`, which drains stdio (#1824).
 *
 * `Bun.spawn` reads a child's pipe eagerly, so this cannot apply back-pressure; what it
 * proves is that the exit waits for every line. A reader that lags behind a full pipe
 * was checked by hand (`cmd | (sleep 1; cat)`): 3,000 of 3,000 lines, 64 KiB without the hook.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const REQUESTS = 300;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "appstrate-cli-batch-sigint-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("appstrate api --batch on Ctrl-C", () => {
  it("accounts for every line and flushes a full pipe before exiting 130", async () => {
    let received = 0;
    let firstFive!: () => void;
    const fiveReceived = new Promise<void>((resolve) => (firstFive = resolve));
    const server = Bun.serve({
      port: 0,
      async fetch() {
        if (++received === 5) firstFive();
        await Bun.sleep(20);
        return Response.json({ padding: "x".repeat(1000) });
      },
    });

    try {
      const file = join(dir, "batch.jsonl");
      await writeFile(
        file,
        Array.from({ length: REQUESTS }, (_, i) => JSON.stringify({ url: `/api/r/${i}` })).join(
          "\n",
        ),
      );
      const child = Bun.spawn(
        [process.execPath, CLI, "api", "--batch", file, "--parallel-max", "1"],
        {
          env: {
            PATH: process.env.PATH ?? "",
            HOME: dir,
            XDG_CONFIG_HOME: join(dir, "config"),
            APPSTRATE_API_KEY: "apst_test",
            APPSTRATE_INSTANCE: `http://localhost:${server.port}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      await fiveReceived;
      child.kill("SIGINT");
      const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);

      expect(code).toBe(130);
      expect(out.endsWith("\n")).toBe(true);
      const lines = out
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, any>);
      expect(lines.map((l) => l.custom_id)).toEqual(
        Array.from({ length: REQUESTS }, (_, i) => String(i + 1)),
      );
      expect(lines.some((l) => l.response?.status_code === 200)).toBe(true);
      expect(lines.at(-1)!.error).toMatchObject({ code: 130 });
    } finally {
      await server.stop(true);
    }
  });
});
