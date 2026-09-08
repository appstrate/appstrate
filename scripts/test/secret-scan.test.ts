// SPDX-License-Identifier: Apache-2.0

/**
 * The pre-commit secret scan, driven as a process against throwaway git repos.
 *
 * The hook has three outcomes and each one is a decision somebody could quietly
 * invert: a staged secret must BLOCK, a clean diff must pass, and a machine
 * without gitleaks must pass with a warning rather than block. That third one
 * is the deliberate exception to "no silent degradation" (see the script's
 * header), so it is the case that most needs an assertion holding it in place —
 * both that it exits 0, and that it does not do so quietly.
 *
 * The absent-binary case is the only one that runs everywhere: it strips
 * `PATH` down to the system directories and calls Bun by absolute path, so it
 * needs nothing installed. The two gitleaks-dependent cases are skipped when
 * the binary is missing, which is honest here rather than vacuous — `bun test`
 * prints them as skipped, and the CI job that would hide a real failure behind
 * a skip does not exist: `Check` runs `bun run check`, not this suite, and the
 * `Secret Scanning` job runs gitleaks against the whole repo directly.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "hooks", "secret-scan.ts");
const HAS_GITLEAKS = Bun.which("gitleaks") !== null;

/**
 * A synthetic GitHub personal-access token: the `ghp_` prefix plus 36
 * characters, which is the shape gitleaks' built-in `github-pat` rule matches.
 *
 * Built from parts at runtime on purpose. Written as one literal it would be a
 * secret-shaped string sitting in a tracked file, and the repo's own CI
 * gitleaks job — which scans the whole tree, not a staged diff — would flag
 * this test as a leak. The value is not a real credential either way.
 */
const FAKE_TOKEN = `ghp_${"0123456789abcdefghijABCDEFGHIJ012345"}`;

const repos: string[] = [];

/** A fresh git repo with one commit, so a staged diff has a parent to differ from. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "secret-scan-"));
  repos.push(dir);
  const git = (...args: string[]) =>
    Bun.spawnSync({ cmd: ["git", ...args], cwd: dir, stdout: "pipe", stderr: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "seed\n");
  git("add", "README.md");
  git("commit", "-qm", "seed");
  return dir;
}

function stage(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content);
  Bun.spawnSync({ cmd: ["git", "add", name], cwd: dir, stdout: "pipe", stderr: "pipe" });
}

function runHook(dir: string, env?: Record<string, string>): { code: number; output: string } {
  const run = Bun.spawnSync({
    // Absolute path to Bun, because the absent-binary case replaces PATH.
    cmd: [process.execPath, SCRIPT],
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env } : {}),
  });
  return { code: run.exitCode ?? 1, output: run.stdout.toString() + run.stderr.toString() };
}

afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

describe("secret-scan hook", () => {
  it("passes and warns loudly when gitleaks is not installed", () => {
    // PATH without the directories a package manager installs gitleaks into.
    // This is the branch that lets a commit through, so the assertion covers
    // both halves: it exits 0, AND it says why and how to fix it.
    const { code, output } = runHook(makeRepo(), { PATH: "/usr/bin:/bin" });

    expect(code).toBe(0);
    expect(output).toContain("gitleaks is not installed");
    expect(output).toContain("brew install gitleaks");
    // And it must not pretend it scanned anything.
    expect(output).toContain("NOT scanned");
  });

  it.skipIf(!HAS_GITLEAKS)("blocks a commit whose staged diff carries a secret", () => {
    const dir = makeRepo();
    stage(dir, "leak.ts", `const token = "${FAKE_TOKEN}";\n`);

    const { code, output } = runHook(dir);

    expect(code).toBe(1);
    expect(output).toContain("commit blocked");
    expect(output).toContain("github-pat");
    // `--redact` must hold: the finding names the rule and the file, never the
    // value. Printing the secret into a terminal (and CI logs) would leak it a
    // second way while reporting the first.
    expect(output).not.toContain(FAKE_TOKEN);
    expect(output).toContain("leak.ts");
  });

  it.skipIf(!HAS_GITLEAKS)("passes on a staged diff with no secret in it", () => {
    // The negative control's other half. Asserting only the block above would
    // not distinguish a working scan from one that fails on everything.
    const dir = makeRepo();
    stage(dir, "ordinary.ts", "export const answer = 42;\n");

    const { code, output } = runHook(dir);

    expect(code).toBe(0);
    expect(output).toContain("no leaks found");
    expect(output).not.toContain("commit blocked");
  });
});
