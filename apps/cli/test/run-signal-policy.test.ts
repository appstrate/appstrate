// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `resolveSignalPolicy` — the decision that says whether a
 * SIGINT/SIGTERM/SIGHUP cancels the platform-side run or merely detaches
 * from it (issue #1020).
 *
 * The resolver is pure (every input injected), so the whole precedence
 * table is asserted exhaustively rather than sampled.
 */

import { describe, it, expect } from "bun:test";
import { Command } from "commander";
import { resolveSignalPolicy, type SignalPolicy } from "../src/commands/run/signal-policy.ts";

describe("resolveSignalPolicy — precedence table", () => {
  // Exhaustive over the three inputs: cancelOnExit (true | false |
  // undefined) × json (true | false) × stdinIsTty (true | false).
  const cases: {
    cancelOnExit: boolean | undefined;
    json: boolean;
    stdinIsTty: boolean;
    expected: SignalPolicy;
    why: string;
  }[] = [
    // 1. Explicit --cancel-on-exit wins over everything.
    {
      cancelOnExit: true,
      json: true,
      stdinIsTty: false,
      expected: "cancel",
      why: "--cancel-on-exit beats --json and a non-TTY stdin",
    },
    {
      cancelOnExit: true,
      json: false,
      stdinIsTty: false,
      expected: "cancel",
      why: "--cancel-on-exit beats a non-TTY stdin",
    },
    {
      cancelOnExit: true,
      json: true,
      stdinIsTty: true,
      expected: "cancel",
      why: "--cancel-on-exit beats --json",
    },
    {
      cancelOnExit: true,
      json: false,
      stdinIsTty: true,
      expected: "cancel",
      why: "--cancel-on-exit agrees with the interactive default",
    },
    // 2. Explicit --no-cancel-on-exit wins over everything, including a
    //    fully interactive terminal.
    {
      cancelOnExit: false,
      json: false,
      stdinIsTty: true,
      expected: "detach",
      why: "--no-cancel-on-exit beats the interactive TTY default",
    },
    {
      cancelOnExit: false,
      json: true,
      stdinIsTty: true,
      expected: "detach",
      why: "--no-cancel-on-exit agrees with --json",
    },
    {
      cancelOnExit: false,
      json: false,
      stdinIsTty: false,
      expected: "detach",
      why: "--no-cancel-on-exit agrees with a non-TTY stdin",
    },
    {
      cancelOnExit: false,
      json: true,
      stdinIsTty: false,
      expected: "detach",
      why: "--no-cancel-on-exit agrees with both auto signals",
    },
    // 3. --json means a machine is reading — detach even on a TTY.
    {
      cancelOnExit: undefined,
      json: true,
      stdinIsTty: true,
      expected: "detach",
      why: "--json implies a scripted caller even from a terminal",
    },
    {
      cancelOnExit: undefined,
      json: true,
      stdinIsTty: false,
      expected: "detach",
      why: "--json and a non-TTY stdin both point at detach",
    },
    // 4. Non-TTY stdin means nobody could have pressed Ctrl-C.
    {
      cancelOnExit: undefined,
      json: false,
      stdinIsTty: false,
      expected: "detach",
      why: "a reaped background process is a lifecycle event, not a cancel",
    },
    // 5. Interactive default.
    {
      cancelOnExit: undefined,
      json: false,
      stdinIsTty: true,
      expected: "cancel",
      why: "interactive Ctrl-C means the user wants the agent stopped",
    },
  ];

  for (const c of cases) {
    it(`cancelOnExit=${String(c.cancelOnExit)} json=${c.json} stdinIsTty=${c.stdinIsTty} → ${c.expected} (${c.why})`, () => {
      expect(
        resolveSignalPolicy({
          cancelOnExit: c.cancelOnExit,
          json: c.json,
          stdinIsTty: c.stdinIsTty,
        }),
      ).toBe(c.expected);
    });
  }

  it("covers every input combination", () => {
    // Guards the table above against silently losing a row in a future
    // edit: 3 cancelOnExit states × 2 json × 2 stdinIsTty = 12.
    expect(cases).toHaveLength(12);
    const keys = new Set(cases.map((c) => `${String(c.cancelOnExit)}|${c.json}|${c.stdinIsTty}`));
    expect(keys.size).toBe(12);
  });
});

describe("--cancel-on-exit commander tri-state", () => {
  /**
   * Mirrors the option pair declared on the `run` command in
   * `src/cli.ts`. `cli.ts` parses `process.argv` at import time, so it
   * cannot be loaded from a test — the declaration is restated here and
   * this test is what proves the shape actually yields three states
   * (commander only leaves the key unset when BOTH the positive flag and
   * its `--no-` negation are declared).
   */
  function parse(argv: string[]): { cancelOnExit?: unknown } {
    const program = new Command();
    program.exitOverride();
    const run = program
      .command("run")
      .argument("<bundle>")
      .option("--cancel-on-exit", "cancel the platform-side run on a signal")
      .option("--no-cancel-on-exit", "detach instead of cancelling")
      .action(() => {});
    program.parse(["node", "appstrate", "run", "@scope/agent", ...argv]);
    return run.opts();
  }

  it("leaves the option undefined when neither flag is passed", () => {
    expect(parse([]).cancelOnExit).toBeUndefined();
  });

  it("sets true for --cancel-on-exit", () => {
    expect(parse(["--cancel-on-exit"]).cancelOnExit).toBe(true);
  });

  it("sets false for --no-cancel-on-exit", () => {
    expect(parse(["--no-cancel-on-exit"]).cancelOnExit).toBe(false);
  });

  it("maps each parsed state to the right policy in a non-interactive shell", () => {
    // End-to-end shape of the wiring in cli.ts → runCommandRemote: a CI
    // step (no TTY, no --json) detaches by default and can still force a
    // cancel with the explicit flag.
    const asOpt = (raw: unknown): boolean | undefined =>
      typeof raw === "boolean" ? raw : undefined;
    const policy = (argv: string[]): SignalPolicy =>
      resolveSignalPolicy({
        cancelOnExit: asOpt(parse(argv).cancelOnExit),
        json: false,
        stdinIsTty: false,
      });
    expect(policy([])).toBe("detach");
    expect(policy(["--cancel-on-exit"])).toBe("cancel");
    expect(policy(["--no-cancel-on-exit"])).toBe("detach");
  });
});
