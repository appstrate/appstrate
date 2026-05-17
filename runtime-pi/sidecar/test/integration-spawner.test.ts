// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the integration-spawner adapter.
 *
 * Two layers of coverage:
 *   1. Pure adapter — `spawnIntegrationProcess` with an injected `spawn`
 *      stub: exit-reason mapping, kill flow, env layering.
 *   2. Smoke test — drive a real subprocess (`bun -e "process.exit(0)"`)
 *      end-to-end so the Bun.spawn wiring is exercised in CI.
 */

import { describe, it, expect } from "bun:test";
import type { SpawnCommandPlan } from "@appstrate/connect";
import {
  makeSupervisedSpawnFactory,
  spawnIntegrationProcess,
  type BunSpawnFn,
  type BunSubprocessLike,
} from "../integration-spawner.ts";

function makeStub() {
  let killed = false;
  const killCalls: Array<string | number | undefined> = [];
  let exitedResolve!: (code: number) => void;
  const exitedPromise = new Promise<number>((res) => {
    exitedResolve = res;
  });
  const proc: BunSubprocessLike = {
    stdin: { write: () => 0, end: () => {} },
    stdout: new ReadableStream({
      start(c) {
        c.close();
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        c.close();
      },
    }),
    exited: exitedPromise,
    pid: 7,
    get killed() {
      return killed;
    },
    kill(signal?: number | string) {
      killCalls.push(signal);
      killed = true;
    },
  };
  return { proc, killCalls, exitedResolve };
}

const PLAN: SpawnCommandPlan = {
  command: "bun",
  args: ["/path/to/server.js"],
  env: { FOO: "bar" },
};

describe("spawnIntegrationProcess — exit reason mapping", () => {
  it("normal exit → kind: normal-exit", async () => {
    const stub = makeStub();
    let onExit:
      | ((
          proc: BunSubprocessLike,
          code: number | null,
          signal: number | null,
          error: Error | null,
        ) => void)
      | undefined;
    const spawn: BunSpawnFn = (_cmd, opts) => {
      onExit = opts.onExit;
      return stub.proc;
    };
    const handle = spawnIntegrationProcess(PLAN, { spawn });
    onExit!(stub.proc, 0, null, null);
    stub.exitedResolve(0);
    const exit = await handle.exited;
    expect(exit).toEqual({ kind: "normal-exit", code: 0 });
  });

  it("signal exit → kind: signal", async () => {
    const stub = makeStub();
    let onExit:
      | ((
          proc: BunSubprocessLike,
          code: number | null,
          signal: number | null,
          error: Error | null,
        ) => void)
      | undefined;
    const spawn: BunSpawnFn = (_cmd, opts) => {
      onExit = opts.onExit;
      return stub.proc;
    };
    const handle = spawnIntegrationProcess(PLAN, { spawn });
    onExit!(stub.proc, null, 15, null);
    stub.exitedResolve(0);
    const exit = await handle.exited;
    expect(exit).toEqual({ kind: "signal", signal: "15" });
  });

  it("error → kind: error", async () => {
    const stub = makeStub();
    let onExit:
      | ((
          proc: BunSubprocessLike,
          code: number | null,
          signal: number | null,
          error: Error | null,
        ) => void)
      | undefined;
    const spawn: BunSpawnFn = (_cmd, opts) => {
      onExit = opts.onExit;
      return stub.proc;
    };
    const handle = spawnIntegrationProcess(PLAN, { spawn });
    const boom = new Error("spawn EACCES");
    onExit!(stub.proc, null, null, boom);
    stub.exitedResolve(0);
    const exit = await handle.exited;
    expect(exit).toEqual({ kind: "error", error: boom });
  });
});

describe("spawnIntegrationProcess — env layering", () => {
  it("passthrough merges with plan.env; plan wins on collision", () => {
    const seen: { env: Record<string, string> } = { env: {} };
    process.env.__SPAWNER_TEST_PASS = "passthrough-value";
    process.env.FOO = "should-be-overridden";
    try {
      const spawn: BunSpawnFn = (_cmd, opts) => {
        seen.env = opts.env;
        return makeStub().proc;
      };
      spawnIntegrationProcess(PLAN, { spawn, envPassthrough: ["__SPAWNER_TEST_PASS", "FOO"] });
      expect(seen.env.__SPAWNER_TEST_PASS).toBe("passthrough-value");
      expect(seen.env.FOO).toBe("bar"); // plan wins
    } finally {
      delete process.env.__SPAWNER_TEST_PASS;
      delete process.env.FOO;
    }
  });

  it("zero passthrough by default → only plan.env survives", () => {
    const seen: { env: Record<string, string> } = { env: {} };
    process.env.__SPAWNER_LEAK = "leak-me";
    try {
      const spawn: BunSpawnFn = (_cmd, opts) => {
        seen.env = opts.env;
        return makeStub().proc;
      };
      spawnIntegrationProcess(PLAN, { spawn });
      expect(seen.env.__SPAWNER_LEAK).toBeUndefined();
      expect(seen.env.FOO).toBe("bar");
    } finally {
      delete process.env.__SPAWNER_LEAK;
    }
  });
});

describe("spawnIntegrationProcess — kill flow", () => {
  it("sends SIGTERM on kill", () => {
    const stub = makeStub();
    const spawn: BunSpawnFn = () => stub.proc;
    const handle = spawnIntegrationProcess(PLAN, { spawn });
    handle.kill("test");
    expect(stub.killCalls).toEqual(["SIGTERM"]);
  });

  it("kill is idempotent", () => {
    const stub = makeStub();
    const spawn: BunSpawnFn = () => stub.proc;
    const handle = spawnIntegrationProcess(PLAN, { spawn });
    handle.kill("a");
    handle.kill("b");
    expect(stub.killCalls).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL after killTimeoutMs", async () => {
    const stub = makeStub();
    const spawn: BunSpawnFn = () => stub.proc;
    const handle = spawnIntegrationProcess(PLAN, { spawn, killTimeoutMs: 30 });
    handle.kill("test");
    // Don't resolve `exited` — the timer should escalate.
    await new Promise((r) => setTimeout(r, 80));
    expect(stub.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does NOT escalate when the process exits within grace", async () => {
    const stub = makeStub();
    const spawn: BunSpawnFn = () => stub.proc;
    const handle = spawnIntegrationProcess(PLAN, { spawn, killTimeoutMs: 200 });
    handle.kill("test");
    stub.exitedResolve(0);
    await new Promise((r) => setTimeout(r, 250));
    expect(stub.killCalls).toEqual(["SIGTERM"]);
  });
});

describe("spawnIntegrationProcess — handle surface", () => {
  it("exposes pid, subprocess, stdio for the MCP wiring layer", () => {
    const stub = makeStub();
    const spawn: BunSpawnFn = () => stub.proc;
    const handle = spawnIntegrationProcess(PLAN, { spawn });
    expect(handle.pid).toBe(7);
    expect(handle.subprocess).toBe(stub.proc);
    expect(handle.stdin).toBe(stub.proc.stdin);
    expect(handle.stdout).toBe(stub.proc.stdout);
    expect(handle.stderr).toBe(stub.proc.stderr);
  });
});

describe("makeSupervisedSpawnFactory", () => {
  it("returns a factory that calls spawn + onSpawn per invocation", async () => {
    let callCount = 0;
    const onSpawnSeen: number[] = [];
    const spawn: BunSpawnFn = () => {
      callCount += 1;
      return makeStub().proc;
    };
    const factory = makeSupervisedSpawnFactory(PLAN, {
      spawn,
      onSpawn: (h) => {
        onSpawnSeen.push(h.pid ?? -1);
      },
    });
    const a = await factory();
    const b = await factory();
    expect(callCount).toBe(2);
    expect(onSpawnSeen.length).toBe(2);
    expect(a.pid).toBe(7);
    expect(b.pid).toBe(7);
  });
});

describe("spawnIntegrationProcess — real subprocess smoke test", () => {
  it("end-to-end with `bun -e 'process.exit(0)'`", async () => {
    const handle = spawnIntegrationProcess(
      { command: "bun", args: ["-e", "process.exit(0)"], env: {} },
      { envPassthrough: ["PATH"] },
    );
    const exit = await handle.exited;
    expect(exit).toEqual({ kind: "normal-exit", code: 0 });
  });

  it("captures non-zero exit code from a real subprocess", async () => {
    const handle = spawnIntegrationProcess(
      { command: "bun", args: ["-e", "process.exit(42)"], env: {} },
      { envPassthrough: ["PATH"] },
    );
    const exit = await handle.exited;
    expect(exit).toEqual({ kind: "normal-exit", code: 42 });
  });

  it("SIGTERM-kills a long-running subprocess", async () => {
    const handle = spawnIntegrationProcess(
      {
        command: "bun",
        args: ["-e", "setInterval(()=>{},1000)"],
        env: {},
      },
      { envPassthrough: ["PATH"], killTimeoutMs: 500 },
    );
    handle.kill("test");
    const exit = await handle.exited;
    // Bun maps signal exits to exitCode = 128 + signal_no on POSIX in
    // some paths and reports the signal in others. Accept either shape.
    expect(["signal", "normal-exit"]).toContain(exit.kind);
  });
});
