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

/**
 * The instance, as far as a command run talks to it. `register` answers
 * `POST /api/runs/remote`; every other route answers 200 and is recorded.
 * `/probe` is the command's own endpoint: a child calls it to say it runs.
 */
function startPlatform(register?: () => Response, warnings: unknown[] = []): Platform {
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
      if (url.pathname !== "/api/runs/remote") return new Response("ok");
      if (register) return register();
      return Response.json(
        {
          id: RUN_ID,
          url: `${url.origin}${EVENTS}`,
          finalize_url: `${url.origin}${FINALIZE}`,
          secret: "ZWZmZWN0aXZlbHkgYW55dGhpbmc=",
          expiresAt: "2099-01-01T00:00:00Z",
          warnings,
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

  beforeEach(() => {
    platform = startPlatform();
    stderr = "";
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
        cwd: CLI_ROOT,
        writeStderr: (chunk) => (stderr += chunk),
        ...over,
      },
      shutdown,
    );
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
    platform = startPlatform(undefined, [
      {
        field: "integrations.@acme/gmail",
        code: "integration_unbound",
        message: "Integration '@acme/gmail' is bound to no connection",
      },
    ]);
    await run(NOOP, { spec: "draft" });
    expect(stderr).toBe(
      `→ running @acme/sync@draft (reporting to ${platform.origin} as ${RUN_ID})\n` +
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
    expect("usage" in result).toBe(false);
  });

  it("returns 128 + n and names the signal when one terminates the command", async () => {
    expect(await run(bun('process.kill(process.pid, "SIGKILL")'))).toBe(137);

    const result = finalizeBody(platform);
    expect(result.status).toBe("failed");
    expect(result.error).toEqual({ message: "Command terminated by SIGKILL" });
  });

  it("never spawns the command when the instance refuses the registration", async () => {
    platform.stop();
    platform = startPlatform(
      () =>
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
    );

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
    expect((result.error as { message: string }).message).toStartWith(
      "Command could not be started: ",
    );
    expect(stderr).toContain("error: Command could not be started: ");
    // The run was registered and taken out of `pending` before the spawn failed.
    expect(platform.on(EVENTS)).toHaveLength(1);
  });

  it("returns 126 for a command that is found but cannot be executed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "appstrate-run-noexec-"));
    try {
      const file = join(dir, "tool.sh");
      await writeFile(file, "#!/bin/sh\nexit 0\n");
      await chmod(file, 0o644);

      expect(await run([file])).toBe(126);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const result = finalizeBody(platform);
    expect(result.status).toBe("failed");
    expect((result.error as { message: string }).message).toStartWith(
      "Command could not be started: ",
    );
    expect(stderr).toContain("error: Command could not be started: ");
  });

  it("on shutdown: terminates the command and finalizes the run cancelled", async () => {
    const running = run(bun(`${probe(platform.origin)} await Bun.sleep(60_000);`));
    const pid = await childPid();

    await shutdown.trigger("SIGTERM", 143);

    expect(isAlive(pid)).toBe(false);
    const result = finalizeBody(platform);
    expect(result.status).toBe("cancelled");
    expect(result.error).toEqual({ message: "Command cancelled (CLI received a signal)." });
    expect(platform.on(FINALIZE)).toHaveLength(1);
    // The coordinator exits once the run is closed, with the signal's code.
    expect(exitCodes).toEqual([143]);
    expect(await running).toBe(143);
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

  // A terminal's Ctrl-C signals the command and the CLI at once. When the
  // command's death is seen first, the shutdown arrives a turn of the event
  // loop later — and the run is still `cancelled`, not `failed`.
  it("reads cancelled when the shutdown lands one turn after the command died of the signal", async () => {
    const running = run(
      bun(`${probe(platform.origin)} await Bun.sleep(50); process.kill(process.pid, "SIGINT");`),
    );
    const pid = await childPid();
    // Runs at every turn of the loop, ahead of anything queued after it: the
    // first turn that finds the command reaped is the one its exit is seen in.
    const triggerOnceReaped = (): void => {
      if (isAlive(pid)) setImmediate(triggerOnceReaped);
      else void shutdown.trigger("SIGINT", 130);
    };
    setImmediate(triggerOnceReaped);

    expect(await running).toBe(130);
    expect(finalizeBody(platform).status).toBe("cancelled");
    expect(platform.on(FINALIZE)).toHaveLength(1);
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

  it("runs the command with the run id; stdout and the exit code are the command's", async () => {
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
    expect(out.stderr).toContain(`→ running @acme/sync@draft (reporting to ${platform.origin}`);
    const body = JSON.parse(platform.on("/api/runs/remote")[0]!.body) as Record<string, unknown>;
    expect(body.source).toEqual({ kind: "registry", packageId: "@acme/sync", stage: "draft" });
    expect(body.input).toEqual({ since: "2026-01-01" });
    expect(body.connection_overrides).toEqual(CONNECTION);
    expect(finalizeBody(platform).status).toBe("failed");
  });

  it("keeps stdout empty when the instance refuses the registration", async () => {
    platform.stop();
    platform = startPlatform(() => new Response("forbidden", { status: 403 }));

    const out = await cli(headless(), "@acme/sync", "--", ...bun('console.log("ran")'));

    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("POST /api/runs/remote failed with HTTP 403");
    expect(out.exitCode).toBe(1);
  });

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
  ] as const)("prints the error on stderr %s", async (_label, args, message) => {
    const out = await cli({}, ...args);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain(message);
    expect(out.exitCode).toBe(1);
    expect(platform.hits).toHaveLength(0);
  });

  it("still refuses extra operands that no `--` introduces", async () => {
    const out = await cli(headless(), "@acme/sync", "python", "sync.py");
    expect(out.stderr).toContain(
      "error: too many arguments for 'run'. Expected 1 argument but got 3.",
    );
    expect(out.exitCode).toBe(1);
    expect(platform.hits).toHaveLength(0);

    const mixed = await cli(headless(), "@acme/sync", "stray", "--", "true");
    expect(mixed.stderr).toContain(
      "error: too many arguments for 'run'. Expected 1 argument but got 2.",
    );
    expect(platform.hits).toHaveLength(0);
  });

  it("leaves an invocation without a command on its usual error stream", async () => {
    // Unchanged for the other modes: their terminal error is rendered on stdout.
    const out = await cli({}, "@acme/sync", "--sink-ttl", "soon");
    expect(out.stdout).toContain("--sink-ttl");
    expect(out.exitCode).toBe(1);
  });

  // Ctrl-C as a terminal delivers it: SIGINT to the whole foreground process
  // group, the CLI and its command together.
  it("cancels the run when the process group is interrupted, and exits 130", async () => {
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
  });
});
