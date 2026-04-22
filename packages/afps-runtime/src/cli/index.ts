// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * `afps` command-line entry point.
 *
 * The CLI exposes the runtime primitives (load, validate, sign, verify,
 * render, test, run) as portable subcommands so any machine with Bun can
 * exercise the same code paths Appstrate uses internally. Live execution
 * (`afps run`) dynamic-imports `@appstrate/runner-pi`; every other command
 * runs with zero extra dependencies.
 *
 * All commands receive a {@link CliIO} for stdout/stderr so tests can
 * capture output without touching the real process streams.
 */

export interface CliIO {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

export interface CliCommand {
  name: string;
  summary: string;
  run: (argv: readonly string[], io: CliIO) => Promise<number> | number;
}

const HELP_TEXT = `afps — AFPS bundle tooling

Usage:
  afps <command> [options]

Commands:
  keygen              Generate an Ed25519 key pair
  sign <bundle>       Add signature.sig to a bundle (re-packs the ZIP)
  verify <bundle>     Validate manifest + template, verify signature
  inspect <bundle>    Print manifest, files, signature summary
  render <bundle>     Render the prompt template against a context
  test <bundle>       Replay scripted events through the sink+reducer
  run <bundle>        Execute a bundle against a real LLM (Pi SDK)
  conformance         Run the AFPS conformance suite (L1–L4)

Run 'afps <command> --help' for per-command options.
`;

/**
 * Dispatch an argv array to the matching subcommand.
 *
 * Returns the subcommand's exit code. Unknown commands return 2; no
 * command (or --help) returns 0 and prints the help text. Uncaught
 * errors thrown by a subcommand are turned into a one-line stderr
 * diagnostic + exit 1 — Bun stack traces never reach end users.
 */
export async function runCli(argv: readonly string[], io: CliIO): Promise<number> {
  const [cmd, ...rest] = argv;

  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    io.stdout(HELP_TEXT);
    return 0;
  }

  const dispatchers: Record<string, () => Promise<number> | number> = {
    keygen: async () => (await import("./commands/keygen.ts")).run(rest, io),
    sign: async () => (await import("./commands/sign.ts")).run(rest, io),
    verify: async () => (await import("./commands/verify.ts")).run(rest, io),
    inspect: async () => (await import("./commands/inspect.ts")).run(rest, io),
    render: async () => (await import("./commands/render.ts")).run(rest, io),
    test: async () => (await import("./commands/test.ts")).run(rest, io),
    run: async () => (await import("./commands/run.ts")).run(rest, io),
    conformance: async () => (await import("./commands/conformance.ts")).run(rest, io),
  };

  const handler = dispatchers[cmd];
  if (!handler) {
    io.stderr(`afps: unknown command '${cmd}'\n`);
    io.stderr(HELP_TEXT);
    return 2;
  }

  try {
    return await handler();
  } catch (err) {
    io.stderr(`afps ${cmd}: ${formatCliError(err)}\n`);
    return 1;
  }
}

function formatCliError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    return `${(err as { message: string }).message} [${String((err as { code: unknown }).code)}]`;
  }
  if (err instanceof Error) {
    // Keep Node fs errors readable: "ENOENT: no such file…" is enough
    // context; suppress the stack and path-object fragment.
    return err.message;
  }
  return String(err);
}

export { HELP_TEXT };
