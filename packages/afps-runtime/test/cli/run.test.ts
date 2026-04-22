// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleExecutionContext,
  createRunHandler,
  type RunDeps,
  type RunnerPiModule,
} from "../../src/cli/commands/run.ts";
import { runCli } from "../../src/cli/index.ts";
import { captureIo, writeBundleFile, writeJsonFile } from "./helpers.ts";
import { generateKeyPair } from "../../src/bundle/signing.ts";

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

describe("afps run — bundle load + signature + context (Phase 2)", () => {
  let dir: string;
  const validArgs = (b: string, extra: string[] = []): string[] => [
    b,
    "--api",
    "anthropic-messages",
    "--model",
    "claude-haiku-4-5-20251001",
    "--api-key",
    "sk-test",
    ...extra,
  ];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "afps-cli-run-phase2-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("exits 3 when the bundle file is not a valid .afps archive", async () => {
    const bundle = join(dir, "bad.afps");
    await writeFile(bundle, "not a zip file");
    const handler = createRunHandler(stubDeps());
    const io = captureIo();
    const code = await handler(validArgs(bundle), io);
    expect(code).toBe(3);
    expect(io.stderrText()).toContain("afps run: invalid bundle:");
  });

  it("exits 3 when the bundle path does not exist", async () => {
    const handler = createRunHandler(stubDeps());
    const io = captureIo();
    const code = await handler(validArgs(join(dir, "nope.afps")), io);
    expect(code).toBe(3);
    expect(io.stderrText()).toContain("afps run: invalid bundle:");
    expect(io.stderrText()).toContain("ENOENT");
  });

  it("exits 3 when --trust-root is required but bundle is unsigned", async () => {
    const bundle = join(dir, "a.afps");
    await writeBundleFile(bundle);
    const trustRoot = join(dir, "trust.json");
    const kp = generateKeyPair();
    await writeJsonFile(trustRoot, {
      keys: [{ keyId: kp.keyId, publicKey: kp.publicKey }],
    });
    const handler = createRunHandler(stubDeps());
    const io = captureIo();
    const code = await handler(validArgs(bundle, ["--trust-root", trustRoot]), io);
    expect(code).toBe(3);
    expect(io.stderrText()).toContain("signature check failed");
    expect(io.stderrText()).toContain("unsigned");
  });

  it("exits 3 when --trust-root does not contain the signing key", async () => {
    const bundle = join(dir, "signed.afps");
    await writeBundleFile(bundle);
    const signingKey = join(dir, "key.json");
    const kp = generateKeyPair();
    await writeJsonFile(signingKey, kp);
    const signIo = captureIo();
    const signCode = await runCli(["sign", bundle, "--key", signingKey], signIo);
    expect(signCode).toBe(0);

    const otherKp = generateKeyPair();
    const wrongTrust = join(dir, "wrong-trust.json");
    await writeJsonFile(wrongTrust, {
      keys: [{ keyId: otherKp.keyId, publicKey: otherKp.publicKey }],
    });

    const handler = createRunHandler(stubDeps());
    const io = captureIo();
    const code = await handler(validArgs(bundle, ["--trust-root", wrongTrust]), io);
    expect(code).toBe(3);
    expect(io.stderrText()).toContain("signature check failed");
  });

  it("proceeds past signature check with a matching trust root", async () => {
    const bundle = join(dir, "signed.afps");
    await writeBundleFile(bundle);
    const signingKey = join(dir, "key.json");
    const kp = generateKeyPair();
    await writeJsonFile(signingKey, kp);
    const signCode = await runCli(["sign", bundle, "--key", signingKey], captureIo());
    expect(signCode).toBe(0);

    const trustRoot = join(dir, "trust.json");
    await writeJsonFile(trustRoot, {
      keys: [{ keyId: kp.keyId, publicKey: kp.publicKey }],
    });

    const handler = createRunHandler(stubDeps());
    const io = captureIo();
    const code = await handler(validArgs(bundle, ["--trust-root", trustRoot]), io);
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("not yet wired");
  });

  it("exits 3 when --trust-root file cannot be read", async () => {
    const bundle = join(dir, "a.afps");
    await writeBundleFile(bundle);
    const handler = createRunHandler(stubDeps());
    const io = captureIo();
    const code = await handler(validArgs(bundle, ["--trust-root", join(dir, "missing.json")]), io);
    expect(code).toBe(3);
    expect(io.stderrText()).toContain("cannot read --trust-root");
  });

  it("exits 3 when --trust-root file is malformed", async () => {
    const bundle = join(dir, "a.afps");
    await writeBundleFile(bundle);
    const bad = join(dir, "bad-trust.json");
    await writeFile(bad, "not json");
    const handler = createRunHandler(stubDeps());
    const io = captureIo();
    const code = await handler(validArgs(bundle, ["--trust-root", bad]), io);
    expect(code).toBe(3);
    expect(io.stderrText()).toContain("cannot read --trust-root");
  });

  it("exits 1 when --context file cannot be read", async () => {
    const bundle = join(dir, "a.afps");
    await writeBundleFile(bundle);
    const handler = createRunHandler(stubDeps());
    const io = captureIo();
    const code = await handler(validArgs(bundle, ["--context", join(dir, "missing.json")]), io);
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("cannot read --context");
  });

  it("exits 1 when --snapshot file has invalid JSON", async () => {
    const bundle = join(dir, "a.afps");
    await writeBundleFile(bundle);
    const bad = join(dir, "bad-snapshot.json");
    await writeFile(bad, "{not json");
    const handler = createRunHandler(stubDeps());
    const io = captureIo();
    const code = await handler(validArgs(bundle, ["--snapshot", bad]), io);
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("cannot read --snapshot");
  });

  it("accepts valid --context and --snapshot files without error", async () => {
    const bundle = join(dir, "a.afps");
    await writeBundleFile(bundle);
    const context = join(dir, "context.json");
    await writeJsonFile(context, { runId: "r1", input: { foo: 1 } });
    const snapshot = join(dir, "snapshot.json");
    await writeJsonFile(snapshot, {
      memories: [{ content: "m", createdAt: 0 }],
      state: { k: "v" },
    });
    const handler = createRunHandler(stubDeps());
    const io = captureIo();
    const code = await handler(
      validArgs(bundle, ["--context", context, "--snapshot", snapshot]),
      io,
    );
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("not yet wired");
  });
});

describe("assembleExecutionContext — pure helper", () => {
  it("defaults runId and input when context file is empty", () => {
    const ctx = assembleExecutionContext({}, {});
    expect(ctx.runId).toBe("cli-run");
    expect(ctx.input).toEqual({});
  });

  it("preserves explicit runId and input from the context file", () => {
    const ctx = assembleExecutionContext({ runId: "run-7", input: { task: "write" } }, {});
    expect(ctx.runId).toBe("run-7");
    expect(ctx.input).toEqual({ task: "write" });
  });

  it("merges snapshot.memories onto the context", () => {
    const ctx = assembleExecutionContext(
      { runId: "r", input: {} },
      { memories: [{ content: "m1", createdAt: 10 }] },
    );
    expect(ctx.memories).toEqual([{ content: "m1", createdAt: 10 }]);
  });

  it("merges snapshot.state onto the context (overrides context state)", () => {
    const ctx = assembleExecutionContext(
      { runId: "r", input: {}, state: { from: "context" } },
      { state: { from: "snapshot" } },
    );
    expect(ctx.state).toEqual({ from: "snapshot" });
  });

  it("merges snapshot.history when provided", () => {
    const ctx = assembleExecutionContext(
      { runId: "r", input: {} },
      { history: [{ runId: "prev", timestamp: 1, output: { done: true } }] },
    );
    expect(ctx.history).toEqual([{ runId: "prev", timestamp: 1, output: { done: true } }]);
  });

  it("keeps snapshot fields absent from the context when not provided", () => {
    const ctx = assembleExecutionContext({ runId: "r", input: {} }, {});
    expect(ctx.memories).toBeUndefined();
    expect(ctx.history).toBeUndefined();
    expect(ctx.state).toBeUndefined();
  });
});
