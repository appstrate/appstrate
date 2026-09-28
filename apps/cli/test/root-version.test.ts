// SPDX-License-Identifier: Apache-2.0

/**
 * `-V, --version` answers at the top level only (#1516).
 *
 * The unit half pins `asksForVersion`; the process half runs the real
 * `src/cli.ts` — the commander wiring is where the bug lived, and the command
 * tests call `packagesPullCommand` directly, past it. `cli.ts` parses
 * `process.argv` at import, so it can only be observed from a child process.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { asksForVersion, valueFlagsOf } from "../src/lib/root-version.ts";
import { CLI_VERSION } from "../src/lib/version.ts";
import { runCli } from "./helpers/isolated-process.ts";

const VALUE_FLAGS = new Set(["-p", "--profile"]);

describe("asksForVersion", () => {
  it("answers for the flag among the program's own options", () => {
    for (const args of [
      ["--version"],
      ["-V"],
      ["--insecure", "--version"],
      ["-p", "prod", "-V"],
      ["--profile", "prod", "--version"],
      ["--profile=prod", "--version"],
      ["--version", "packages", "pull"],
      ["-Vp", "prod"],
    ]) {
      expect(asksForVersion(args, VALUE_FLAGS)).toBe(true);
    }
  });

  it("leaves the flag to the command once a command word is read", () => {
    for (const args of [
      ["packages", "pull", "@a/b", "--version", "1.0.0"],
      ["packages", "--version"],
      ["whoami", "-V"],
      ["-p", "prod", "packages", "publish", "@a/b", "--version"],
    ]) {
      expect(asksForVersion(args, VALUE_FLAGS)).toBe(false);
    }
  });

  it("reads a value flag's value as that value, even when it spells the flag", () => {
    // `appstrate -p --version whoami` names a profile called `--version`, as
    // commander parses it; the scan must not disagree with the parser.
    expect(asksForVersion(["-p", "--version", "whoami"], VALUE_FLAGS)).toBe(false);
    // A cluster is split left to right: `-pV` names the profile `V`.
    expect(asksForVersion(["-pV", "whoami"], VALUE_FLAGS)).toBe(false);
  });

  it("stops at `--` and at a bare `-`", () => {
    expect(asksForVersion(["--", "--version"], VALUE_FLAGS)).toBe(false);
    expect(asksForVersion(["-", "--version"], VALUE_FLAGS)).toBe(false);
  });

  it("answers nothing for an empty line", () => {
    expect(asksForVersion([], VALUE_FLAGS)).toBe(false);
  });
});

describe("valueFlagsOf", () => {
  it("collects every spelling of the options that require a value, and nothing else", () => {
    // An optional value (`[n]`) never swallows a following `-…` argument in
    // commander, so it cannot hide a `--version` and must not be skipped over.
    const program = new Command()
      .option("-p, --profile <name>", "profile")
      .option("--level [n]", "optional value")
      .option("--insecure", "boolean");
    expect([...valueFlagsOf(program)].sort()).toEqual(["--profile", "-p"]);
  });
});

describe("the real CLI", () => {
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "appstrate-cli-root-version-"));
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const cli = (...args: string[]) => runCli(home, ...args);

  it("prints its version for -V / --version at the top level", async () => {
    for (const args of [["--version"], ["-V"], ["--profile", "prod", "--version"], ["-Vp", "x"]]) {
      const out = await cli(...args);
      expect(out).toEqual({ stdout: `${CLI_VERSION}\n`, stderr: "", exitCode: 0 });
    }
  });

  it("refuses --version after a command instead of printing the CLI's version", async () => {
    // Delete-to-fail (#1516): `.version()` on the program printed the version
    // and exited 0 here, whatever the command was about to do.
    for (const args of [
      ["packages", "pull", "@acme/pdf", "--version", "1.0.0"],
      ["packages", "pull", "--version=1.0.0", "@acme/pdf"],
      ["packages", "publish", "@acme/pdf", "--version", "2.0.0"],
      ["whoami", "-V"],
    ]) {
      const out = await cli(...args);
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toMatch(/error: unknown option '(--version|-V)/);
      // The help-only flag must not come back as a suggestion for itself.
      expect(out.stderr).not.toContain("Did you mean");
      expect(out.stdout).not.toContain(CLI_VERSION);
    }
  });

  it("still lists -V, --version in the top-level help, and only there", async () => {
    const top = await cli("--help");
    expect(top.exitCode).toBe(0);
    expect(top.stdout).toContain("-V, --version");
    expect(top.stdout).toContain("output the version number");

    const pull = await cli("packages", "pull", "--help");
    expect(pull.exitCode).toBe(0);
    expect(pull.stdout).not.toContain("--version");
    expect(pull.stdout).toContain("<package>@<spec>");
  });
});
