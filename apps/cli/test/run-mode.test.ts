// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `resolveExecutionMode` and `validateOptsForMode` —
 * the two pure functions that govern the dual-default behaviour of
 * `appstrate run` (id → remote, path → local) and its command mode
 * (`-- <command>`), plus `commandAfterSeparator`, which reads the command
 * off the raw arguments.
 *
 * Pure logic, no I/O: these tests are intentionally cheap so the full
 * matrix (target × flag combinations × validation) stays exhaustive.
 */

import { describe, it, expect } from "bun:test";
import {
  commandAfterSeparator,
  resolveExecutionMode,
  validateOptsForMode,
  ExecutionModeError,
} from "../src/commands/run/mode.ts";
import { parseRunTarget } from "../src/commands/run/package-spec.ts";

const idTarget = parseRunTarget("@system/hello-world");
const pathTarget = parseRunTarget("./bundle.afps");

describe("resolveExecutionMode — defaults", () => {
  it("defaults id-mode targets to remote", () => {
    expect(resolveExecutionMode(idTarget, {})).toBe("remote");
  });

  it("defaults path-mode targets to local", () => {
    expect(resolveExecutionMode(pathTarget, {})).toBe("local");
  });

  it("defaults id-mode targets with a pinned spec to remote", () => {
    const target = parseRunTarget("@system/hello-world@1.0.0");
    expect(resolveExecutionMode(target, {})).toBe("remote");
  });
});

describe("resolveExecutionMode — explicit --local", () => {
  it("forces local for an id target", () => {
    expect(resolveExecutionMode(idTarget, { local: true })).toBe("local");
  });

  it("is a no-op for a path target (already local)", () => {
    expect(resolveExecutionMode(pathTarget, { local: true })).toBe("local");
  });
});

describe("resolveExecutionMode — explicit --remote", () => {
  it("keeps remote for an id target (no-op)", () => {
    expect(resolveExecutionMode(idTarget, { remote: true })).toBe("remote");
  });

  it("rejects a path target", () => {
    expect(() => resolveExecutionMode(pathTarget, { remote: true })).toThrow(ExecutionModeError);
  });

  it("rejection message mentions the path/remote conflict", () => {
    try {
      resolveExecutionMode(pathTarget, { remote: true });
      throw new Error("expected throw");
    } catch (err) {
      if (!(err instanceof ExecutionModeError)) throw err;
      expect(err.message).toMatch(/--remote does not support local bundle paths/);
      expect(err.hint).toMatch(/`@scope\/agent` id/);
    }
  });
});

describe("resolveExecutionMode — flag conflict", () => {
  it("rejects --local + --remote together", () => {
    expect(() => resolveExecutionMode(idTarget, { local: true, remote: true })).toThrow(
      ExecutionModeError,
    );
  });

  it("conflict error names both flags", () => {
    try {
      resolveExecutionMode(idTarget, { local: true, remote: true });
      throw new Error("expected throw");
    } catch (err) {
      if (!(err instanceof ExecutionModeError)) throw err;
      expect(err.message).toMatch(/--local and --remote are mutually exclusive/);
    }
  });

  it("rejects flag conflict even on a path target", () => {
    // The conflict is decided BEFORE the path/remote rule, so the
    // user gets the more specific error first.
    expect(() => resolveExecutionMode(pathTarget, { local: true, remote: true })).toThrow(
      /mutually exclusive/,
    );
  });
});

describe("validateOptsForMode — local mode", () => {
  it("accepts every local-execution flag", () => {
    expect(() =>
      validateOptsForMode("local", {
        snapshot: "/tmp/s.json",
        credsFile: "/tmp/c.json",
        llmApiKey: "sk-test",
        modelApi: "openai-responses",
        modelSource: "env",
        integrations: "local",
        report: "true",
        reportFallback: "console",
        sinkTtl: 600,
      }),
    ).not.toThrow();
  });

  it.each([
    ["--cancel-on-exit", { cancelOnExit: true }],
    ["--no-cancel-on-exit", { cancelOnExit: false }],
  ])("rejects %s in local mode (no platform-side run to keep alive)", (flag, opts) => {
    try {
      validateOptsForMode("local", opts);
      throw new Error("expected throw");
    } catch (err) {
      if (!(err instanceof ExecutionModeError)) throw err;
      expect(err.message).toContain(flag);
      expect(err.hint).toMatch(/--remote/);
    }
  });

  it("stays silent when the tri-state flag is absent", () => {
    expect(() => validateOptsForMode("local", { cancelOnExit: undefined })).not.toThrow();
  });
});

describe("validateOptsForMode — remote mode", () => {
  it("accepts an empty opts object", () => {
    expect(() => validateOptsForMode("remote", {})).not.toThrow();
  });

  it("accepts --cancel-on-exit in both directions (remote-only flag)", () => {
    expect(() => validateOptsForMode("remote", { cancelOnExit: true })).not.toThrow();
    expect(() => validateOptsForMode("remote", { cancelOnExit: false })).not.toThrow();
  });

  it("accepts --integrations=remote (the implicit default)", () => {
    expect(() => validateOptsForMode("remote", { integrations: "remote" })).not.toThrow();
  });

  it.each([
    ["snapshot", { snapshot: "/tmp/s.json" }],
    ["credsFile", { credsFile: "/tmp/c.json" }],
    ["llmApiKey", { llmApiKey: "sk-test" }],
    ["modelApi", { modelApi: "openai-responses" }],
    ["modelSource", { modelSource: "env" }],
    ["report", { report: "true" }],
    ["reportFallback", { reportFallback: "console" }],
    ["sinkTtl", { sinkTtl: 600 }],
  ])("rejects %s in remote mode", (_label, opts) => {
    expect(() => validateOptsForMode("remote", opts)).toThrow(ExecutionModeError);
  });

  it("rejects --integrations=local|none in remote mode", () => {
    expect(() => validateOptsForMode("remote", { integrations: "local" })).toThrow(
      ExecutionModeError,
    );
    expect(() => validateOptsForMode("remote", { integrations: "none" })).toThrow(
      ExecutionModeError,
    );
  });

  it("error message lists every offender so the user fixes them in one pass", () => {
    try {
      validateOptsForMode("remote", {
        snapshot: "/tmp/s.json",
        credsFile: "/tmp/c.json",
        llmApiKey: "sk-test",
      });
      throw new Error("expected throw");
    } catch (err) {
      if (!(err instanceof ExecutionModeError)) throw err;
      expect(err.message).toMatch(/--snapshot/);
      expect(err.message).toMatch(/--creds-file/);
      expect(err.message).toMatch(/--llm-api-key/);
      expect(err.hint).toMatch(/--local/);
    }
  });
});

describe("commandAfterSeparator", () => {
  it("returns undefined when the arguments hold no `--`", () => {
    expect(commandAfterSeparator(["run", "@a/b", "--input", "{}"])).toBeUndefined();
  });

  it("returns everything after the first `--`, options of the command included", () => {
    expect(commandAfterSeparator(["run", "@a/b", "--", "python", "sync.py", "--flag"])).toEqual([
      "python",
      "sync.py",
      "--flag",
    ]);
  });

  it("splits on the first `--` only: a later one belongs to the command", () => {
    expect(
      commandAfterSeparator(["run", "@a/b", "--connection", "@a/x=1", "--", "npm", "--", "t"]),
    ).toEqual(["npm", "--", "t"]);
  });

  it("returns an empty command for a trailing `--`", () => {
    expect(commandAfterSeparator(["run", "@a/b", "--"])).toEqual([]);
  });
});

describe("resolveExecutionMode — command", () => {
  const command = ["python", "sync.py"];

  it("resolves command mode for an id target, with or without a spec", () => {
    expect(resolveExecutionMode(idTarget, { command })).toBe("command");
    expect(resolveExecutionMode(parseRunTarget("@system/hello-world@draft"), { command })).toBe(
      "command",
    );
  });

  it("stays out of command mode without a command", () => {
    expect(resolveExecutionMode(idTarget, { command: undefined })).toBe("remote");
  });

  it("refuses a `--` followed by nothing", () => {
    expect(() => resolveExecutionMode(idTarget, { command: [] })).toThrow(
      "`--` is followed by no command",
    );
  });

  it("refuses a path target: the run is one of a registered agent", () => {
    try {
      resolveExecutionMode(pathTarget, { command });
      throw new Error("expected throw");
    } catch (err) {
      if (!(err instanceof ExecutionModeError)) throw err;
      expect(err.message).toMatch(/not a local bundle path/);
      expect(err.hint).toMatch(/`@scope\/agent` id/);
    }
  });

  it.each([
    ["--local", { local: true }],
    ["--remote", { remote: true }],
  ])("refuses %s with a command", (flag, opts) => {
    try {
      resolveExecutionMode(idTarget, { command, ...opts });
      throw new Error("expected throw");
    } catch (err) {
      if (!(err instanceof ExecutionModeError)) throw err;
      expect(err.message).toContain(flag);
      expect(err.hint).toContain(`Drop ${flag}`);
    }
  });
});

describe("validateOptsForMode — command mode", () => {
  it("accepts the options a command run acts on", () => {
    // As `cli.ts` passes them: absent booleans are `false`, absent values undefined.
    expect(() =>
      validateOptsForMode("command", {
        command: ["true"],
        sinkTtl: 600,
        local: false,
        remote: false,
        json: false,
        verbose: false,
        quiet: false,
        noInherit: false,
        cancelOnExit: undefined,
      }),
    ).not.toThrow();
  });

  it.each([
    ["--snapshot", { snapshot: "/tmp/s.json" }],
    ["--creds-file", { credsFile: "/tmp/c.json" }],
    ["--llm-api-key", { llmApiKey: "sk-test" }],
    ["--model", { model: "claude" }],
    ["--model-api", { modelApi: "openai-responses" }],
    ["--model-source", { modelSource: "preset" }],
    ["--integrations", { integrations: "remote" }],
    ["--integrations", { integrations: "none" }],
    ["--report", { report: "true" }],
    ["--report-fallback", { reportFallback: "console" }],
    ["--output", { output: "/tmp/out.json" }],
    ["--json", { json: true }],
    ["--verbose", { verbose: true }],
    ["--quiet", { quiet: true }],
    ["--proxy", { proxy: "prx_1" }],
    ["--no-inherit", { noInherit: true }],
    ["--run-id", { runId: "run_x" }],
    ["--cancel-on-exit", { cancelOnExit: true }],
    ["--no-cancel-on-exit", { cancelOnExit: false }],
  ])("refuses %s, with a reason", (flag, opts) => {
    try {
      validateOptsForMode("command", opts);
      throw new Error("expected throw");
    } catch (err) {
      if (!(err instanceof ExecutionModeError)) throw err;
      expect(err.message).toMatch(/not supported in command execution mode/);
      // `  <flag> — <reason>`: the flag starts its line, a reason follows it.
      expect(err.message).toMatch(new RegExp(`\\n  ${flag} — \\S`));
      expect(err.hint).toMatch(/-- <command>/);
    }
  });

  it("lists every offender so the user fixes them in one pass", () => {
    try {
      validateOptsForMode("command", { json: true, model: "claude", cancelOnExit: false });
      throw new Error("expected throw");
    } catch (err) {
      if (!(err instanceof ExecutionModeError)) throw err;
      expect(err.message.split("\n")).toHaveLength(4);
      expect(err.message).toContain("--json");
      expect(err.message).toContain("--model");
      expect(err.message).toContain("--no-cancel-on-exit");
    }
  });
});
