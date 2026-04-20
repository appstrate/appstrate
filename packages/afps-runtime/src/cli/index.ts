// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * `afps` command-line entry point.
 *
 * The CLI exposes the runtime primitives (load, validate, sign,
 * verify, render) as portable subcommands so any machine with Bun can
 * exercise the same code paths Appstrate uses internally. Execution of
 * bundles against a real LLM (Pi Coding Agent) ships in Phase 10.
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
  conformance         Run the AFPS conformance suite (L1–L3)

Run 'afps <command> --help' for per-command options.
`;

/**
 * Dispatch an argv array to the matching subcommand.
 *
 * Returns the subcommand's exit code. Unknown commands return 2; no
 * command (or --help) returns 0 and prints the help text.
 */
export async function runCli(argv: readonly string[], io: CliIO): Promise<number> {
  const [cmd, ...rest] = argv;

  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    io.stdout(HELP_TEXT);
    return 0;
  }

  switch (cmd) {
    case "keygen":
      return (await import("./commands/keygen.ts")).run(rest, io);
    case "sign":
      return (await import("./commands/sign.ts")).run(rest, io);
    case "verify":
      return (await import("./commands/verify.ts")).run(rest, io);
    case "inspect":
      return (await import("./commands/inspect.ts")).run(rest, io);
    case "render":
      return (await import("./commands/render.ts")).run(rest, io);
    case "conformance":
      return (await import("./commands/conformance.ts")).run(rest, io);
    default:
      io.stderr(`afps: unknown command '${cmd}'\n`);
      io.stderr(HELP_TEXT);
      return 2;
  }
}

export { HELP_TEXT };
