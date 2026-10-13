// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate run @scope/agent -- <command>` — the CLI as the runner of a
 * remote run whose work is a command (`run/command-runner.ts`).
 *
 * The orchestration runs against a fake platform (a real HTTP server answering
 * the registration, the events URL, the heartbeat and the finalize) and real
 * child processes, so what is asserted is what the instance receives and what
 * the command sees. The last block drives the real `src/cli.ts` in a child:
 * commander's handling of `--`, and which stream each outcome prints on.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommandAsRunner } from "../src/commands/run/command-runner.ts";
import { ReportStartError } from "../src/commands/run/report.ts";
import { ShutdownCoordinator } from "../src/lib/shutdown.ts";

/** `apps/cli`: the cwd every child is pinned to, whichever directory `bun test` runs from. */
const CLI_ROOT = join(import.meta.dir, "..");
const RUN_ID = "run_command_test";
const CONNECTION = { "@acme/gmail": ["11111111-1111-4111-8111-111111111111"] };

interface Hit {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: string;
}

interface Platform {
  origin: string;
  hits: Hit[];
  /** The hits on `path`, in arrival order. */
  on: (path: string) => Hit[];
  /** Resolves with the next hit on `path` (or the first, if it already arrived). */
  next: (path: string) => Promise<Hit>;
  stop: () => void;
}

const EVENTS = `/api/runs/${RUN_ID}/events`;
const FINALIZE = `${EVENTS}/finalize`;
const HEARTBEAT = `${EVENTS}/heartbeat`;

/**
 * The instance, as far as a command run talks to it. Every request is
 * recorded. `answer` scripts a path; unscripted, `POST /api/runs/remote`
 * registers the run (with `warnings`) and any other route answers 200.
 * `/probe` is the command's own endpoint: a child calls it to say it runs.
 */
function startPlatform(
  opts: { warnings?: unknown[]; answer?: Record<string, () => Response> } = {},
): Platform {
  const hits: Hit[] = [];
  const waiters: { path: string; resolve: (hit: Hit) => void }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const hit: Hit = {
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body: await req.text(),
      };
      hits.push(hit);
      for (const waiter of waiters.splice(0)) {
        if (waiter.path === hit.path) waiter.resolve(hit);
        else waiters.push(waiter);
      }
      const scripted = opts.answer?.[url.pathname];
      if (scripted) return scripted();
      if (url.pathname !== "/api/runs/remote") return new Response("ok");
      return Response.json(
        {
          id: RUN_ID,
          url: `${url.origin}${EVENTS}`,
          finalize_url: `${url.origin}${FINALIZE}`,
          secret: "ZWZmZWN0aXZlbHkgYW55dGhpbmc=",
          expiresAt: "2099-01-01T00:00:00Z",
          warnings: opts.warnings ?? [],
        },
        { status: 201 },
      );
    },
  });
  const on = (path: string): Hit[] => hits.filter((hit) => hit.path === path);
  return {
    origin: `http://localhost:${server.port}`,
    hits,
    on,
    next: (path) => {
      const seen = on(path)[0];
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve) => waiters.push({ path, resolve }));
    },
    stop: () => server.stop(true),
  };
}

/** A Bun child running `code`. */
const bun = (code: string): string[] => [process.execPath, "-e", code];

/** A command that does nothing and exits 0. */
const NOOP = bun("0");

/** Snippet: tell the platform this child runs, with the run id it was given and its pid. */
const probe = (origin: string): string =>
  `await fetch("${origin}/probe?run=" + process.env.APPSTRATE_RUN_ID + "&pid=" + process.pid);`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const finalizeBody = (platform: Platform): Record<string, unknown> =>
  JSON.parse(platform.on(FINALIZE)[0]!.body) as Record<string, unknown>;

describe("runCommandAsRunner", () => {
  let platform: Platform;
  let stderr: string;
  let exitCodes: number[];
  let shutdown: ShutdownCoordinator;
  let children: number[];
  let stderrWaiters: { text: string; resolve: () => void }[];

  beforeEach(() => {
    platform = startPlatform();
    stderr = "";
    stderrWaiters = [];
    exitCodes = [];
    children = [];
    shutdown = new ShutdownCoordinator({ exit: (code) => void exitCodes.push(code) });
  });

  afterEach(() => {
    platform.stop();
    for (const pid of children) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  });

  function run(
    command: string[],
    over: Partial<Parameters<typeof runCommandAsRunner>[0]> = {},
  ): Promise<number> {
    return runCommandAsRunner(
      {
        command,
        packageId: "@acme/sync",
        spec: undefined,
        context: {
          instance: platform.origin,
          bearerToken: "apst_test",
          spaceId: "spc_1",
          orgId: "org_1",
        },
        input: {},
        writeStderr: (chunk) => {
          stderr += chunk;
          for (const waiter of stderrWaiters.splice(0)) {
            if (stderr.includes(waiter.text)) waiter.resolve();
            else stderrWaiters.push(waiter);
          }
        },
        ...over,
      },
      shutdown,
    );
  }

  /** Resolves once the runner has written `text` on stderr. */
  function stderrSays(text: string): Promise<void> {
    if (stderr.includes(text)) return Promise.resolve();
    return new Promise((resolve) => stderrWaiters.push({ text, resolve }));
  }

  /** The pid a child reported through its probe; killed after the test if it survived. */
  async function childPid(): Promise<number> {
    const pid = Number((await platform.next("/probe")).query.get("pid"));
    children.push(pid);
    return pid;
  }

  it("registers the run by id, with the input, the connection picks and the sink TTL", async () => {
    await run(NOOP, {
      spec: "1.2.0",
      input: { since: "2026-01-01" },
      connectionOverrides: CONNECTION,
      ttlSeconds: 900,
    });

    const [registration] = platform.on("/api/runs/remote");
    expect(registration!.method).toBe("POST");
    expect(registration!.headers.get("authorization")).toBe("Bearer apst_test");
    expect(registration!.headers.get("x-space-id")).toBe("spc_1");
    expect(registration!.headers.get("x-org-id")).toBe("org_1");
    // The kind the platform reads to let a run finish `success` with zero tokens.
    expect(registration!.headers.get("x-appstrate-runner-kind")).toBe("command");
    const body = JSON.parse(registration!.body) as Record<string, unknown>;
    // By id only: no bundle was fetched, so there is no manifest or prompt to send.
    expect(body.source).toEqual({
      kind: "registry",
      packageId: "@acme/sync",
      stage: "published",
      spec: "1.2.0",
    });
    expect(body.spaceId).toBe("spc_1");
    expect(body.input).toEqual({ since: "2026-01-01" });
    expect(body.connection_overrides).toEqual(CONNECTION);
    expect(body.sink).toEqual({ ttl_seconds: 900 });
    expect(Object.keys(body.contextSnapshot as object).sort()).toEqual(["cliVersion", "os"]);
  });

  it.each([
    ["draft", { kind: "registry", packageId: "@acme/sync", stage: "draft" }],
    ["published", { kind: "registry", packageId: "@acme/sync", stage: "published" }],
    [undefined, { kind: "registry", packageId: "@acme/sync", stage: "published" }],
  ])("names the version like a local run of the id does (spec %p)", async (spec, source) => {
    await run(NOOP, { spec });
    const body = JSON.parse(platform.on("/api/runs/remote")[0]!.body) as Record<string, unknown>;
    expect(body.source).toEqual(source);
    expect("connection_overrides" in body).toBe(false);
    expect("sink" in body).toBe(false);
  });

  it("gives the command the registered run id, after the run's first event", async () => {
    expect(await run(bun(probe(platform.origin)))).toBe(0);

    expect(platform.on("/probe")[0]!.query.get("run")).toBe(RUN_ID);
    // Registration, then the event that takes the run out of `pending`, and
    // only then the command; the finalize closes the run after it.
    expect(platform.hits.map((hit) => hit.path)).toEqual([
      "/api/runs/remote",
      EVENTS,
      "/probe",
      FINALIZE,
    ]);
    const event = JSON.parse(platform.on(EVENTS)[0]!.body) as Record<string, unknown>;
    expect(event.type).toBe("appstrate.progress");
    expect(JSON.stringify(event)).toContain("runtime ready");
  });

  it("announces the run and the integrations it starts without, on stderr", async () => {
    platform.stop();
    platform = startPlatform({
      warnings: [
        {
          field: "integrations.@acme/gmail",
          code: "integration_unbound",
          message: "Integration '@acme/gmail' is bound to no connection",
        },
      ],
    });
    await run(NOOP, { spec: "draft" });
    expect(stderr).toBe(
      `→ running a command under @acme/sync@draft (reporting to ${platform.origin} as ${RUN_ID})\n` +
        "⚠ @acme/gmail: Integration '@acme/gmail' is bound to no connection (integration_unbound)\n",
    );
  });

  it("finalizes success on exit 0, with a zero usage and no error", async () => {
    expect(await run(bun("process.exit(0)"))).toBe(0);

    const result = finalizeBody(platform);
    expect(result.status).toBe("success");
    // A success must state its usage; a command calls no model.
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect("error" in result).toBe(false);
    expect("cost" in result).toBe(false);
    expect(Number.isInteger(result.durationMs)).toBe(true);
    expect(platform.on(FINALIZE)).toHaveLength(1);
  });

  it("finalizes failed on a non-zero exit and returns the command's code", async () => {
    expect(await run(bun("process.exit(3)"))).toBe(3);

    const result = finalizeBody(platform);
    expect(result.status).toBe("failed");
    expect(result.error).toEqual({ message: "Command exited with code 3" });
    // Zero whatever the outcome: a command calls no model.
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  // A terminal's Ctrl-C signals the command and the CLI at once. The command
  // answers it by dying of it, or by exiting with a code of its own (a shell's
  // 130), and either can be seen before the CLI's own shutdown starts.
  describe.each([
    ["dies of the signal", 'process.kill(process.pid, "SIGINT");', "Command terminated by SIGINT"],
    ["exits with a code of its own", "process.exit(130);", "Command exited with code 130"],
  ])("a command that %s", (_shape, ending, failure) => {
    it("reads failed, with the command's code, when no shutdown follows", async () => {
      expect(await run(bun(ending))).toBe(130);

      const result = finalizeBody(platform);
      expect(result.status).toBe("failed");
      expect(result.error).toEqual({ message: failure });
      expect(exitCodes).toEqual([]);
    });

    it("reads cancelled when the shutdown lands shortly after it ended", async () => {
      const running = run(bun(`${probe(platform.origin)} await Bun.sleep(50); ${ending}`));
      const pid = await childPid();
      while (isAlive(pid)) await Bun.sleep(1);

      await shutdown.trigger("SIGINT", 130);

      expect(await running).toBe(130);
      expect(finalizeBody(platform).status).toBe("cancelled");
      expect(platform.on(FINALIZE)).toHaveLength(1);
    });
  });

  it("gives the command the environment it is handed, the run id last", async () => {
    const report =
      `await fetch("${platform.origin}/probe?profile=" + process.env.APPSTRATE_PROFILE` +
      ` + "&key=" + process.env.APPSTRATE_API_KEY + "&run=" + process.env.APPSTRATE_RUN_ID);`;
    await run(bun(report), {
      env: {
        APPSTRATE_PROFILE: "staging",
        APPSTRATE_API_KEY: "apst_flag",
        APPSTRATE_RUN_ID: "run_not_this_one",
      },
    });

    const { query } = platform.on("/probe")[0]!;
    expect(query.get("profile")).toBe("staging");
    expect(query.get("key")).toBe("apst_flag");
    expect(query.get("run")).toBe(RUN_ID);
  });

  it("keeps the run alive with signed heartbeats while the command runs", async () => {
    // An interval whose per-attempt deadline (half of it) is far above a local
    // round-trip. The command runs until the test has seen a heartbeat land.
    const running = run(bun(`${probe(platform.origin)} await Bun.sleep(60_000);`), {
      heartbeatIntervalMs: 200,
    });
    const pid = await childPid();
    await platform.next(HEARTBEAT);
    process.kill(pid, "SIGKILL");
    await running;

    const beats = platform.on(HEARTBEAT);
    expect(beats.length).toBeGreaterThanOrEqual(1);
    expect(beats[0]!.method).toBe("POST");
    expect(beats[0]!.headers.get("webhook-signature")).toStartWith("v1,");
    expect(beats[0]!.headers.get("webhook-id")).toBeTruthy();
    // The heartbeat stops with the command: none follows the finalize.
    expect(platform.hits.at(-1)!.path).toBe(FINALIZE);
  });

  // The run was cancelled through the API, failed by the watchdog, or outlived
  // its sink TTL: the command is told once, runs on, and nothing is finalized.
  it("says once that the run is closed on the instance, lets the command finish, sends no finalize", async () => {
    platform.stop();
    platform = startPlatform({
      answer: { [HEARTBEAT]: () => new Response("gone", { status: 410 }) },
    });

    // The command ends, with a code of its own, when the test asks it to: once
    // the runner has read the instance's answer and said so.
    const running = run(
      bun(
        `process.on("SIGTERM", () => process.exit(5)); ` +
          `${probe(platform.origin)} await Bun.sleep(60_000);`,
      ),
      { heartbeatIntervalMs: 200 },
    );
    const pid = await childPid();
    await stderrSays("is closed on the instance");
    process.kill(pid, "SIGTERM");

    expect(await running).toBe(5);
    // Once is the point: the loop stops on the first 410.
    expect(stderr.match(/is closed on the instance/g)).toHaveLength(1);
    expect(stderr).toContain(
      `warn: run ${RUN_ID} is closed on the instance, which reports nothing more for it and stops serving the calls that name it. The command keeps running.\n`,
    );
    expect(platform.on(HEARTBEAT).length).toBeGreaterThanOrEqual(1);
    expect(platform.on(FINALIZE)).toHaveLength(0);
    expect(stderr).not.toContain("finalize failed");
  });

  // What refuses the first event refuses every later signed call: the command
  // would run under a run the platform fails at its boot deadline.
  it("does not start the command when the run's first event is refused", async () => {
    platform.stop();
    platform = startPlatform({
      answer: {
        [EVENTS]: () =>
          Response.json(
            { code: "timestamp_out_of_tolerance", detail: "Timestamp out of tolerance" },
            { status: 401 },
          ),
      },
    });

    expect(await run(bun(probe(platform.origin)))).toBe(1);

    expect(platform.on("/probe")).toHaveLength(0);
    expect(platform.on(HEARTBEAT)).toHaveLength(0);
    expect(stderr).toContain("error: The run's first event could not be delivered: ");
    expect(stderr).toContain("401");
    expect(stderr).toContain("error: The command was not started.\n");
    const result = finalizeBody(platform);
    expect(result.status).toBe("failed");
    expect((result.error as { message: string }).message).toStartWith(
      "The run's first event could not be delivered: ",
    );
  });

  it("never spawns the command when the instance refuses the registration", async () => {
    platform.stop();
    platform = startPlatform({
      answer: {
        "/api/runs/remote": () =>
          new Response(
            JSON.stringify({
              code: "missing_integration_connection",
              errors: [
                {
                  field: "integrations.@acme/gmail",
                  code: "required_integration_unbound",
                  message: "Integration '@acme/gmail' is required and bound to no connection",
                },
              ],
            }),
            { status: 409, headers: { "Content-Type": "application/problem+json" } },
          ),
      },
    });

    const err = await run(bun(probe(platform.origin))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReportStartError);
    expect((err as Error).message).toBe(
      "POST /api/runs/remote failed with HTTP 409" +
        "\n    @acme/gmail: Integration '@acme/gmail' is required and bound to no connection (required_integration_unbound)",
    );
    expect(platform.hits.map((hit) => hit.path)).toEqual(["/api/runs/remote"]);
    expect(stderr).toBe("");
  });

  it("finalizes failed and returns 127 for a command that is not found", async () => {
    expect(await run(["appstrate-test-no-such-command"])).toBe(127);

    const result = finalizeBody(platform);
    expect(result.status).toBe("failed");
    // The platform is told the kind of failure, never the command.
    expect(result.error).toEqual({ message: "Command could not be started: not found" });
    expect(stderr).toContain("error: Command could not be started: ");
    expect(stderr).toContain("appstrate-test-no-such-command");
    // The run was registered and taken out of `pending` before the spawn failed.
    expect(platform.on(EVENTS)).toHaveLength(1);
  });

  // 126, as a shell reports a file it found and could not execute.
  it.each([
    ["without the execute bit", "#!/bin/sh\nexit 0\n", 0o644],
    ["executable but in no format the system runs", "exit 0\n", 0o755],
  ])(
    "returns 126 for a file %s, and keeps its path off the platform",
    async (_label, content, mode) => {
      const dir = await mkdtemp(join(tmpdir(), "appstrate-run-noexec-"));
      const file = join(dir, "tool.sh");
      try {
        await writeFile(file, content);
        await chmod(file, mode);

        expect(await run([file])).toBe(126);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }

      expect(finalizeBody(platform).error).toEqual({
        message: "Command could not be started: not executable",
      });
      expect(platform.on(FINALIZE)[0]!.body).not.toContain(dir);
      // The full text, path included, is for this terminal only.
      expect(stderr).toContain("error: Command could not be started: ");
      expect(stderr).toContain(file);
    },
  );

  it("names the error code of any other spawn failure, and returns 127", async () => {
    const code = await run(["anything"], {
      spawn: () => {
        throw Object.assign(new Error("EMFILE: too many open files, posix_spawn '/x/tool'"), {
          code: "EMFILE",
        });
      },
    });

    expect(code).toBe(127);
    expect(finalizeBody(platform).error).toEqual({
      message: "Command could not be started: spawn error EMFILE",
    });
  });

  it("on shutdown: terminates the command and finalizes the run cancelled", async () => {
    const running = run(bun(`${probe(platform.origin)} await Bun.sleep(60_000);`));
    const pid = await childPid();

    await shutdown.trigger("SIGTERM", 143);

    expect(isAlive(pid)).toBe(false);
    const result = finalizeBody(platform);
    expect(result.status).toBe("cancelled");
    expect(result.error).toEqual({ message: "Command cancelled (CLI received a signal)." });
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(platform.on(FINALIZE)).toHaveLength(1);
    // The coordinator exits once the run is closed, with the signal's code.
    expect(exitCodes).toEqual([143]);
    expect(await running).toBe(143);
  });

  // The run — and with it the command's access — closes at once: the finalize
  // does not wait for a command that takes its time, or ignores the request.
  it("on shutdown: closes the run while a command that ignores the request is alive", async () => {
    // A grace no test reaches: the command is alive when the finalize lands
    // whatever the host's load, and the test ends it itself.
    const running = run(
      bun(`process.on("SIGTERM", () => {}); ${probe(platform.origin)} await Bun.sleep(60_000);`),
      { stopGraceMs: 600_000 },
    );
    const pid = await childPid();

    const stopped = shutdown.trigger("SIGINT", 130);
    await platform.next(FINALIZE);
    expect(isAlive(pid)).toBe(true);
    expect(finalizeBody(platform).status).toBe("cancelled");

    process.kill(pid, "SIGKILL");
    await stopped;
    expect(await running).toBe(137);
  });

  it("on shutdown: kills a command that ignores the request once the grace has passed", async () => {
    const running = run(
      bun(`process.on("SIGTERM", () => {}); ${probe(platform.origin)} await Bun.sleep(60_000);`),
      { stopGraceMs: 100 },
    );
    const pid = await childPid();

    await shutdown.trigger("SIGINT", 130);

    expect(isAlive(pid)).toBe(false);
    expect(finalizeBody(platform).status).toBe("cancelled");
    expect(await running).toBe(137);
  });

  // A command's process this user may not signal (EPERM): stopping it fails,
  // which must neither escape as an unhandled rejection while the finalize is
  // awaited, nor throw out of the `exit` event.
  it("survives a command it cannot signal, on shutdown and at process exit", async () => {
    const exit = Promise.withResolvers<number>();
    const double = {
      exited: exit.promise,
      exitCode: null as number | null,
      signalCode: null,
      kill: (): void => {
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      },
    };
    const armed = process.listeners("exit");
    const spawned = Promise.withResolvers<void>();
    const running = run(["anything"], {
      spawn: () => {
        spawned.resolve();
        return double;
      },
    });
    // Resolved from inside the spawn, this resumes once the runner's synchronous
    // stretch from the spawn to its next await is over: the listener is armed.
    await spawned.promise;
    const [atExit] = process.listeners("exit").filter((listener) => !armed.includes(listener));

    expect(() => (atExit as () => void)()).not.toThrow();

    await shutdown.trigger("SIGTERM", 143);
    expect(finalizeBody(platform).status).toBe("cancelled");
    expect(stderr).toContain("warn: stopping the command failed: kill EPERM\n");
    expect(exitCodes).toEqual([143]);

    double.exitCode = 1;
    exit.resolve(1);
    expect(await running).toBe(1);
  });

  it("listens for the process's exit only while the command is alive", async () => {
    const baseline = process.listenerCount("exit");
    const running = run(bun(`${probe(platform.origin)} await Bun.sleep(60_000);`));
    const pid = await childPid();
    expect(process.listenerCount("exit")).toBe(baseline + 1);

    process.kill(pid, "SIGKILL");
    await running;
    expect(process.listenerCount("exit")).toBe(baseline);
  });

  it("starts nothing when the shutdown arrives before the command would", async () => {
    await shutdown.trigger("SIGINT", 130);
    await run(bun(probe(platform.origin)));

    expect(platform.on("/probe")).toHaveLength(0);
    expect(finalizeBody(platform).status).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// The real CLI
// ---------------------------------------------------------------------------

/** A cold `bun src/cli.ts` start takes seconds on a loaded host: over Bun's 5 s default. */
const CLI_TIMEOUT_MS = 20_000;

describe("appstrate run … -- <command> (src/cli.ts)", () => {
  let home: string;
  let platform: Platform;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "appstrate-run-command-"));
    platform = startPlatform();
  });

  afterEach(async () => {
    platform.stop();
    await rm(home, { recursive: true, force: true });
  });

  /** Headless credentials for the fake platform; `{}` leaves the CLI unauthenticated. */
  const headless = (): Record<string, string> => ({
    APPSTRATE_API_KEY: "apst_test",
    APPSTRATE_INSTANCE: platform.origin,
    APPSTRATE_SPACE_ID: "spc_1",
  });

  function cliEnv(extra: Record<string, string>): Record<string, string> {
    return {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      APPSTRATE_NO_DUAL_INSTALL_CHECK: "1",
      NO_COLOR: "1",
      ...extra,
    };
  }

  async function cli(env: Record<string, string>, ...args: string[]) {
    const proc = Bun.spawn([process.execPath, "src/cli.ts", "run", ...args], {
      cwd: CLI_ROOT,
      env: cliEnv(env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  it(
    "runs the command with the run id; stdout and the exit code are the command's",
    async () => {
      const out = await cli(
        headless(),
        "@acme/sync@draft",
        "--input",
        '{"since":"2026-01-01"}',
        "--connection",
        "@acme/gmail=11111111-1111-4111-8111-111111111111",
        "--",
        "sh",
        "-c",
        'echo "$APPSTRATE_RUN_ID" "$@"; exit 4',
        "sh",
        "--flag",
        "-x",
      );

      // Options written after `--` reach the command untouched.
      expect(out.stdout).toBe(`${RUN_ID} --flag -x\n`);
      expect(out.exitCode).toBe(4);
      expect(out.stderr).toContain(
        `→ running a command under @acme/sync@draft (reporting to ${platform.origin}`,
      );
      const body = JSON.parse(platform.on("/api/runs/remote")[0]!.body) as Record<string, unknown>;
      expect(body.source).toEqual({ kind: "registry", packageId: "@acme/sync", stage: "draft" });
      expect(body.input).toEqual({ since: "2026-01-01" });
      expect(body.connection_overrides).toEqual(CONNECTION);
      expect(finalizeBody(platform).status).toBe("failed");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "keeps stdout empty when the instance refuses the registration",
    async () => {
      platform.stop();
      platform = startPlatform({
        answer: { "/api/runs/remote": () => new Response("forbidden", { status: 403 }) },
      });

      const out = await cli(headless(), "@acme/sync", "--", ...bun('console.log("ran")'));

      expect(out.stdout).toBe("");
      expect(out.stderr).toContain("POST /api/runs/remote failed with HTTP 403");
      expect(out.exitCode).toBe(1);
    },
    CLI_TIMEOUT_MS,
  );

  it.each([
    ["without credentials", ["@acme/sync", "--", "true"], "appstrate login"],
    ["on a refused flag", ["@acme/sync", "--json", "--", "true"], "--json — "],
    ["on a `--` followed by nothing", ["@acme/sync", "--"], "`--` is followed by no command"],
    ["on a path target", ["./agent.afps", "--", "true"], "not a local bundle path"],
    [
      "on a malformed option value",
      ["@acme/sync", "--sink-ttl", "soon", "--", "true"],
      "--sink-ttl",
    ],
  ] as const)(
    "prints the error on stderr %s",
    async (_label, args, message) => {
      const out = await cli({}, ...args);
      expect(out.stdout).toBe("");
      expect(out.stderr).toContain(message);
      expect(out.exitCode).toBe(1);
      expect(platform.hits).toHaveLength(0);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "refuses extra operands that no `--` introduces",
    async () => {
      const out = await cli(headless(), "@acme/sync", "python", "sync.py");
      expect(out.stderr).toContain(
        "error: too many arguments for 'run'. Expected 1 argument but got 3: @acme/sync, python, sync.py.",
      );
      expect(out.exitCode).toBe(1);
      expect(platform.hits).toHaveLength(0);
    },
    CLI_TIMEOUT_MS,
  );

  // An option never takes `--` as its value: it is the separator, whatever
  // precedes it.
  it.each([
    [["@acme/sync", "--input", "--", "true"], "--input <json>"],
    [["@acme/sync", "--connection", "--", "true"], "--connection <integration>=<connection-id>"],
    [["@acme/sync", "-p", "--", "true"], "-p, --profile <name>"],
    [["@acme/sync", "--input", "--", "--", "true"], "--input <json>"],
  ] as const)(
    "refuses `--` given as an option's value (%j)",
    async (args, flags) => {
      const out = await cli(headless(), ...args);
      expect(out.stdout).toBe("");
      expect(out.stderr).toContain(
        `error: option '${flags}' argument missing: \`--\` is not a value, it ends the options`,
      );
      expect(out.exitCode).toBe(1);
      expect(platform.hits).toHaveLength(0);
    },
    CLI_TIMEOUT_MS,
  );

  // Ahead of the bundle, `--` only ends option parsing: this is a plain run of
  // the agent on the instance, not a command.
  it(
    "runs the agent itself when the `--` precedes the bundle",
    async () => {
      platform.stop();
      platform = startPlatform({
        answer: { "/api/agents/@acme/sync/run": () => new Response("{}", { status: 403 }) },
      });

      await cli(headless(), "--", "@acme/sync");

      expect(platform.hits.map((hit) => hit.path)).toEqual(["/api/agents/@acme/sync/run"]);
    },
    CLI_TIMEOUT_MS,
  );

  // `--profile` and `--api-key` exist for the CLI's process only; a command
  // that calls `appstrate` itself must resolve the same instance and identity.
  it(
    "hands the command the profile and the API key its flags named",
    async () => {
      const { APPSTRATE_API_KEY: _key, ...withoutKey } = headless();
      const out = await cli(
        withoutKey,
        "--profile",
        "staging",
        "--api-key",
        "apst_flag",
        "@acme/sync",
        "--",
        "sh",
        "-c",
        'echo "$APPSTRATE_PROFILE $APPSTRATE_API_KEY"',
      );

      expect(out.stdout).toBe("staging apst_flag\n");
      expect(out.exitCode).toBe(0);
      expect(platform.on("/api/runs/remote")[0]!.headers.get("authorization")).toBe(
        "Bearer apst_flag",
      );
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "renders the error of an invocation without a command on stdout, like every other command",
    async () => {
      const out = await cli({}, "@acme/sync", "--sink-ttl", "soon");
      expect(out.stdout).toContain("--sink-ttl");
      expect(out.exitCode).toBe(1);
    },
    CLI_TIMEOUT_MS,
  );

  // Ctrl-C as a terminal delivers it: SIGINT to the whole foreground process
  // group, the CLI and its command together.
  it(
    "cancels the run when the process group is interrupted, and exits 130",
    async () => {
      const proc = spawn(
        process.execPath,
        [
          "src/cli.ts",
          "run",
          "@acme/sync",
          "--",
          ...bun(`${probe(platform.origin)} await Bun.sleep(60_000);`),
        ],
        { cwd: CLI_ROOT, env: cliEnv(headless()), detached: true, stdio: "ignore" },
      );
      const exited = new Promise<number | null>((resolve) => proc.on("close", resolve));
      const pid = Number((await platform.next("/probe")).query.get("pid"));

      process.kill(-proc.pid!, "SIGINT");

      expect(await exited).toBe(130);
      expect(isAlive(pid)).toBe(false);
      expect(finalizeBody(platform).status).toBe("cancelled");
    },
    CLI_TIMEOUT_MS,
  );

  // A second Ctrl-C cuts the shutdown short. The run is closed already, and no
  // exit of the CLI leaves its command running.
  it(
    "a second interrupt exits at once and takes a command that ignores signals with it",
    async () => {
      const proc = Bun.spawn(
        [
          process.execPath,
          "src/cli.ts",
          "run",
          "@acme/sync",
          "--",
          ...bun(
            `process.on("SIGINT", () => {}); process.on("SIGTERM", () => {}); ` +
              `${probe(platform.origin)} await Bun.sleep(60_000);`,
          ),
        ],
        {
          cwd: CLI_ROOT,
          env: cliEnv(headless()),
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const pid = Number((await platform.next("/probe")).query.get("pid"));
      try {
        proc.kill("SIGINT");
        await platform.next(FINALIZE);
        expect(finalizeBody(platform).status).toBe("cancelled");
        // Asked to stop, the command is alive: its grace has just started.
        expect(isAlive(pid)).toBe(true);

        proc.kill("SIGINT");
        expect(await proc.exited).toBe(130);
        for (let waited = 0; isAlive(pid) && waited < 2_000; waited += 10) await Bun.sleep(10);
        expect(isAlive(pid)).toBe(false);
      } finally {
        if (isAlive(pid)) process.kill(pid, "SIGKILL");
      }
    },
    CLI_TIMEOUT_MS,
  );
});
