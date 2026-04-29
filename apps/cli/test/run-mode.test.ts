// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `resolveExecutionMode` and `validateOptsForMode` —
 * the two pure functions that govern the dual-default behaviour of
 * `appstrate run` (id → remote, path → local).
 *
 * Pure logic, no I/O: these tests are intentionally cheap so the full
 * matrix (target × flag combinations × validation) stays exhaustive.
 */

import { describe, it, expect } from "bun:test";
import {
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
  it("never rejects in local mode (every flag is supported locally)", () => {
    expect(() =>
      validateOptsForMode("local", {
        snapshot: "/tmp/s.json",
        credsFile: "/tmp/c.json",
        llmApiKey: "sk-test",
        modelApi: "openai-responses",
        modelSource: "env",
        providers: "local",
        report: "true",
        reportFallback: "console",
        sinkTtl: 600,
        noPreflight: true,
        preflightTimeout: 60,
        connectionProfile: "default",
        providerProfile: ["@x/y=abc"],
      }),
    ).not.toThrow();
  });
});

describe("validateOptsForMode — remote mode", () => {
  it("accepts an empty opts object", () => {
    expect(() => validateOptsForMode("remote", {})).not.toThrow();
  });

  it("accepts --providers=remote (the implicit default)", () => {
    expect(() => validateOptsForMode("remote", { providers: "remote" })).not.toThrow();
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
    ["noPreflight", { noPreflight: true }],
    ["preflightTimeout", { preflightTimeout: 60 }],
    ["connectionProfile", { connectionProfile: "default" }],
    ["providerProfile", { providerProfile: ["@x/y=abc"] }],
  ])("rejects %s in remote mode", (_label, opts) => {
    expect(() => validateOptsForMode("remote", opts)).toThrow(ExecutionModeError);
  });

  it("rejects --providers=local|none in remote mode", () => {
    expect(() => validateOptsForMode("remote", { providers: "local" })).toThrow(ExecutionModeError);
    expect(() => validateOptsForMode("remote", { providers: "none" })).toThrow(ExecutionModeError);
  });

  it("ignores empty providerProfile arrays (commander default for unrepeated flag)", () => {
    expect(() => validateOptsForMode("remote", { providerProfile: [] })).not.toThrow();
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
