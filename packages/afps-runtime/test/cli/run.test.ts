// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunHandler, type RunDeps, type RunnerPiModule } from "../../src/cli/commands/run.ts";
import { runCli } from "../../src/cli/index.ts";
import { captureIo, writeBundleFile } from "./helpers.ts";

/**
 * Minimal stub module — Phase 1 never invokes PiRunner, so the shapes
 * are placeholders. Later phases enrich the stub.
 */
function stubModule(): RunnerPiModule {
  return {
    PiRunner: class {
      readonly name = "stub-pi-runner";
      async run(): Promise<void> {
        /* noop */
      }
    },
    prepareBundleForPi: async () => ({
      extensionFactories: [],
      cleanup: async () => {},
    }),
  };
}

function stubDeps(overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    loadRunnerPi: async () => stubModule(),
    ...overrides,
  };
}

describe("afps run — arg parsing (Phase 1)", () => {
  let dir: string;
  let bundle: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "afps-cli-run-live-"));
    bundle = join(dir, "a.afps");
    await writeBundleFile(bundle);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.AFPS_API_KEY;
  });

  it("prints --help with exit 0", async () => {
    const handler = createRunHandler(stubDeps());
    const io = captureIo();
    const code = await handler(["--help"], io);
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("afps run — execute a bundle");
    expect(io.stdoutText()).toContain("--api");
    expect(io.stdoutText()).toContain("--model");
  });

  it("fails with exit 2 when <bundle> positional is missing", async () => {
    const handler = createRunHandler(stubDeps());
    const io = captureIo();
    const code = await handler(
      ["--api", "anthropic-messages", "--model", "claude-haiku-4-5-20251001"],
      io,
    );
    expect(code).toBe(2);
    expect(io.stderrText()).toContain("missing <bundle> argument");
  });

  it("fails with exit 2 when --api is missing", async () => {
    const handler = createRunHandler(stubDeps());
    const io = captureIo();
    const code = await handler([bundle, "--model", "x"], io);
    expect(code).toBe(2);
    expect(io.stderrText()).toContain("--api <api> is required");
  });

  it("fails with exit 2 when --model is missing", async () => {
    const handler = createRunHandler(stubDeps());
    const io = captureIo();
    const code = await handler([bundle, "--api", "anthropic-messages"], io);
    expect(code).toBe(2);
    expect(io.stderrText()).toContain("--model <id> is required");
  });

  it("fails with exit 2 when no API key is resolvable", async () => {
    delete process.env.AFPS_API_KEY;
    const handler = createRunHandler(stubDeps());
    const io = captureIo();
    const code = await handler([bundle, "--api", "anthropic-messages", "--model", "x"], io);
    expect(code).toBe(2);
    expect(io.stderrText()).toContain("missing API key");
    expect(io.stderrText()).toContain("$AFPS_API_KEY");
  });

  it("reads API key from $AFPS_API_KEY when --api-key absent", async () => {
    process.env.AFPS_API_KEY = "sk-from-env";
    const handler = createRunHandler(stubDeps());
    const io = captureIo();
    // Phase 1 early-returns 1 after arg validation succeeds — confirms
    // the key resolution path didn't short-circuit on arg validation.
    const code = await handler([bundle, "--api", "anthropic-messages", "--model", "x"], io);
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("not yet wired");
    // Critical: env-sourced API key never appears in stderr.
    expect(io.stderrText()).not.toContain("sk-from-env");
  });

  it("rejects unknown flags with exit 2", async () => {
    const handler = createRunHandler(stubDeps());
    const io = captureIo();
    const code = await handler(
      [bundle, "--api", "x", "--model", "y", "--api-key", "k", "--unknown", "z"],
      io,
    );
    expect(code).toBe(2);
    expect(io.stderrText()).toContain("afps run:");
  });

  it("is registered in the CLI dispatch map", async () => {
    const io = captureIo();
    // Drives the real production handler via dispatch. Expected to fail
    // on loadRunnerPi (runner-pi present in workspace, but subsequent
    // phases early-return) OR on the Phase 1 placeholder. Either way
    // the code path exists — we just assert dispatch recognises `run`.
    const code = await runCli(["run", "--help"], io);
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("afps run —");
  });
});

describe("afps run — runner-pi loading (Phase 1)", () => {
  let dir: string;
  let bundle: string;
  const validArgs = (b: string): string[] => [
    b,
    "--api",
    "anthropic-messages",
    "--model",
    "claude-haiku-4-5-20251001",
    "--api-key",
    "sk-test",
  ];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "afps-cli-run-load-"));
    bundle = join(dir, "a.afps");
    await writeBundleFile(bundle);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("fails with exit 1 + install hint when @appstrate/runner-pi is missing", async () => {
    const handler = createRunHandler({
      loadRunnerPi: async () => {
        const err = new Error("Cannot find package '@appstrate/runner-pi' imported from …");
        (err as { code?: string }).code = "MODULE_NOT_FOUND";
        throw err;
      },
    });
    const io = captureIo();
    const code = await handler(validArgs(bundle), io);
    expect(code).toBe(1);
    const stderr = io.stderrText();
    expect(stderr).toContain("'@appstrate/runner-pi' is not installed");
    expect(stderr).toContain("bun add @appstrate/runner-pi");
  });

  it("distinguishes missing @mariozechner/pi-coding-agent peer dep", async () => {
    const handler = createRunHandler({
      loadRunnerPi: async () => {
        throw new Error("Cannot find module '@mariozechner/pi-coding-agent' imported from …");
      },
    });
    const io = captureIo();
    const code = await handler(validArgs(bundle), io);
    expect(code).toBe(1);
    const stderr = io.stderrText();
    expect(stderr).toContain("'@mariozechner/pi-coding-agent' is not installed");
    expect(stderr).toContain("peer dependency");
  });

  it("falls back to a generic message for unexpected loader errors", async () => {
    const handler = createRunHandler({
      loadRunnerPi: async () => {
        throw new Error("boom");
      },
    });
    const io = captureIo();
    const code = await handler(validArgs(bundle), io);
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("failed to load @appstrate/runner-pi: boom");
  });

  it("proceeds past loadRunnerPi when the module resolves", async () => {
    const handler = createRunHandler(stubDeps());
    const io = captureIo();
    const code = await handler(validArgs(bundle), io);
    // Phase 1 placeholder — execution not yet wired.
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("not yet wired");
  });
});
