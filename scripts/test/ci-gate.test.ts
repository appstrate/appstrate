// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "ci-gate.sh");
const SHA = "a1b2c3";

let stubDir: string;

// A `gh` on PATH answering the two calls the script makes from fixtures, and
// logging every call so the test sees which endpoints were asked.
beforeAll(async () => {
  stubDir = await mkdtemp(join(tmpdir(), "ci-gate-"));
  await writeFile(
    join(stubDir, "gh"),
    `#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
[ -n "\${GH_FAIL:-}" ] && exit 1
case "$2" in
  */actions/workflows/*/runs\\?*) printf '%s' "$RUNS_JSON" ;;
  */actions/runs/*) printf '%s' "$RUN_JSON" ;;
  *) exit 1 ;;
esac
`,
  );
  await chmod(join(stubDir, "gh"), 0o755);
});

afterAll(async () => {
  await rm(stubDir, { recursive: true, force: true });
});

interface Outcome {
  code: number;
  stdout: string;
  calls: string[];
}

async function gate(
  args: string[],
  opts: { newerRunNumbers?: number[]; ghFails?: boolean } = {},
): Promise<Outcome> {
  const log = join(stubDir, `calls-${crypto.randomUUID()}`);
  await writeFile(log, "");
  const runs = [7, ...(opts.newerRunNumbers ?? [])].map((n) => ({
    run_number: n,
    html_url: `https://github.com/o/r/actions/runs/${1000 + n}`,
  }));
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    env: {
      PATH: `${stubDir}:${process.env.PATH}`,
      GH_LOG: log,
      GH_FAIL: opts.ghFails ? "1" : "",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_RUN_ID: "1007",
      RUN_JSON: JSON.stringify({ workflow_id: 42, head_sha: SHA, run_number: 7 }),
      RUNS_JSON: JSON.stringify({ workflow_runs: runs }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const calls = (await readFile(log, "utf8")).split("\n").filter(Boolean);
  return { code, stdout, calls };
}

describe("ci-gate.sh", () => {
  it("passes an accepted result without asking the API", async () => {
    expect(await gate(["success", "success"])).toMatchObject({ code: 0, calls: [] });
    expect(await gate(["skipped", "success", "skipped"])).toMatchObject({ code: 0, calls: [] });
  });

  it("fails a result outside the accepted set", async () => {
    const failure = await gate(["failure", "success"]);
    expect(failure.code).toBe(1);
    expect(failure.stdout).toContain("::error::upstream jobs: failure");
    expect(failure.calls).toEqual([]);
    expect((await gate(["skipped", "success"])).code).toBe(1);
  });

  it("passes a cancelled result when a newer run exists for the same commit", async () => {
    const out = await gate(["cancelled", "success"], { newerRunNumbers: [8, 9] });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("::notice::");
    expect(out.stdout).toContain("https://github.com/o/r/actions/runs/1009");
    expect(out.calls).toEqual([
      "api repos/o/r/actions/runs/1007",
      `api repos/o/r/actions/workflows/42/runs?head_sha=${SHA}&per_page=100`,
    ]);
  });

  it("fails a cancelled result when no newer run exists", async () => {
    const out = await gate(["cancelled", "success", "skipped"]);
    expect(out.code).toBe(1);
    expect(out.stdout).toContain(`::error::upstream jobs cancelled, and no newer run`);
  });

  it("ignores older runs on the same commit", async () => {
    const out = await gate(["cancelled", "success"], { newerRunNumbers: [3, 5] });
    expect(out.code).toBe(1);
  });

  it("fails when the API cannot be read", async () => {
    expect((await gate(["cancelled", "success"], { ghFails: true })).code).toBe(1);
  });

  it("refuses a call without an accepted result", async () => {
    expect((await gate(["success"])).code).toBe(2);
  });
});
