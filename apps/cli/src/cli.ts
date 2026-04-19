#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate` — official Appstrate CLI entry point.
 *
 * Commands:
 *   - `appstrate install`: install Appstrate locally or bring up Docker.
 *   - `appstrate login`:   RFC 8628 device-flow against an instance.
 *   - `appstrate logout`:  revoke the session + wipe local storage.
 *   - `appstrate whoami`:  server-authoritative identity check.
 *   - `appstrate token`:   print access + refresh token metadata (debug).
 *   - `appstrate api`:     authenticated HTTP passthrough for coding agents.
 *
 * Global flags:
 *   - `--profile <name>` selects which profile (keyring entry + TOML
 *     section) the command operates on. Falls back to
 *     `APPSTRATE_PROFILE` / `defaultProfile` / `"default"`. See
 *     `lib/config.ts::resolveProfileName`.
 *
 * Top-level error handling: any unhandled rejection ends the process
 * via `formatError` so DeviceFlowError / ApiError / AuthError render
 * with user-actionable text rather than raw stack traces.
 */

import { Command } from "commander";
import { installCommand } from "./commands/install.ts";
import { loginCommand } from "./commands/login.ts";
import { logoutCommand } from "./commands/logout.ts";
import { whoamiCommand } from "./commands/whoami.ts";
import { tokenCommand } from "./commands/token.ts";
import { apiCommand } from "./commands/api.ts";
import { exitWithError } from "./lib/ui.ts";
import { CLI_VERSION } from "./lib/version.ts";

/**
 * Commander's idiomatic "collect repeated option into array" — needed
 * for `-H`, `-F`, `-q` on `appstrate api` where users repeat the flag
 * (curl-compatible).
 */
function collect(val: string, prev: string[]): string[] {
  return [...prev, val];
}

// Catch stray unhandled rejections + uncaughts before Bun's default
// stack-trace dump kicks in — commands are async and may throw after
// commander's callback completes.
process.on("unhandledRejection", (err) => exitWithError(err));
process.on("uncaughtException", (err) => exitWithError(err));

const program = new Command();

program
  .name("appstrate")
  .description("Official CLI for the Appstrate platform")
  .version(CLI_VERSION)
  .option(
    "-p, --profile <name>",
    "Profile to use (overrides APPSTRATE_PROFILE / defaultProfile / 'default').",
  )
  .option(
    "--insecure",
    "Allow connecting to a non-HTTPS, non-loopback instance. Your bearer token will be transmitted in plaintext — only use on a trusted network. Equivalent to APPSTRATE_INSECURE=1.",
  )
  .hook("preAction", () => {
    // Hoist `--insecure` into the env so every downstream module that
    // reads it (instance-url.ts::isInsecureOptIn) sees a single source
    // of truth — no need to thread the flag through every command.
    if (program.opts<{ insecure?: boolean }>().insecure) {
      process.env.APPSTRATE_INSECURE = "1";
    }
  });

program
  .command("install")
  .description("Install Appstrate locally (Tier 0) or bring up the Docker stack (Tiers 1/2/3)")
  .option(
    "-t, --tier <0|1|2|3>",
    "Skip the interactive tier prompt (0 = hobby / Bun, 1/2/3 = Docker stacks).",
  )
  .option("-d, --dir <path>", "Install directory (default: ~/appstrate).")
  .option(
    "--port <port>",
    "Host port the Appstrate platform binds to (default: 3000). Also honored via APPSTRATE_PORT.",
  )
  .option(
    "--minio-console-port <port>",
    "Host port the MinIO console binds to on Tier 3 (default: 9001). Also honored via APPSTRATE_MINIO_CONSOLE_PORT.",
  )
  .option(
    "--force",
    "Bypass the 'another Compose project is already running under this name' preflight. Only use if you have already backed up the other install's data.",
  )
  .action(async (opts) => {
    await installCommand({
      tier: typeof opts.tier === "string" ? opts.tier : undefined,
      dir: typeof opts.dir === "string" ? opts.dir : undefined,
      port: typeof opts.port === "string" ? opts.port : undefined,
      minioConsolePort:
        typeof opts.minioConsolePort === "string" ? opts.minioConsolePort : undefined,
      force: opts.force === true,
    });
  });

program
  .command("login")
  .description("Sign in to an Appstrate instance via the device-flow grant")
  .option("--instance <url>", "Instance URL (skips the interactive prompt).")
  .action(async (opts) => {
    const globalOpts = program.opts<{ profile?: string }>();
    await loginCommand({
      profile: globalOpts.profile,
      instance: typeof opts.instance === "string" ? opts.instance : undefined,
    });
  });

program
  .command("logout")
  .description("Revoke the active session and wipe local credentials")
  .action(async () => {
    const globalOpts = program.opts<{ profile?: string }>();
    await logoutCommand({ profile: globalOpts.profile });
  });

program
  .command("whoami")
  .description("Print the active profile's identity")
  .action(async () => {
    const globalOpts = program.opts<{ profile?: string }>();
    await whoamiCommand({ profile: globalOpts.profile });
  });

program
  .command("token")
  .description("Print metadata about the stored access + refresh tokens (debug)")
  .action(async () => {
    const globalOpts = program.opts<{ profile?: string }>();
    await tokenCommand({ profile: globalOpts.profile });
  });

program
  .command("api <method> <path>")
  .description(
    "Authenticated HTTP passthrough to the Appstrate API. Injects the active profile's bearer token + X-Org-Id so coding agents (Claude Code, Cursor, Aider, …) can call the API without ever seeing the raw token.",
  )
  .option("-H, --header <kv>", "Request header 'Name: value' (repeatable)", collect, [])
  .option("-d, --data <str>", "Request body — literal, @file, or @- for stdin")
  .option("--data-raw <str>", "Request body — literal, no @ interpretation")
  .option(
    "--data-binary <str>",
    "Request body — literal or @file, no content-type guess, no newline stripping",
  )
  .option(
    "-F, --form <kv>",
    "Multipart field 'k=v' or 'k=@path[;type=mime]' (repeatable)",
    collect,
    [],
  )
  .option("-q, --query <kv>", "Query parameter 'k=v' (repeatable)", collect, [])
  .option("-X, --request <method>", "Override method (takes precedence over positional)")
  .option("-o, --output <file>", "Write response body to file (default: stdout)")
  .option("-i, --include", "Include status line + response headers on stdout")
  .option("-I, --head", "Send HEAD and print headers only")
  .option("-s, --silent", "Suppress the 401 re-login hint on stderr")
  .option("-f, --fail", "Exit 22 (4xx) / 25 (5xx) on non-2xx; body to stderr instead of stdout")
  .option(
    "-L, --location",
    "Follow redirects (cross-origin hops strip Authorization per WHATWG fetch)",
  )
  .option(
    "-k, --insecure",
    "Skip TLS verification for THIS request (conflicts with global --insecure)",
  )
  .option("--max-time <sec>", "Abort the request after N seconds (curl exit code 28)", (v) =>
    parseFloat(v),
  )
  .action(async (method: string, path: string, opts) => {
    const globalOpts = program.opts<{ profile?: string }>();
    await apiCommand({
      profile: globalOpts.profile,
      method,
      path,
      header: Array.isArray(opts.header) ? opts.header : [],
      form: Array.isArray(opts.form) ? opts.form : [],
      query: Array.isArray(opts.query) ? opts.query : [],
      data: typeof opts.data === "string" ? opts.data : undefined,
      dataRaw: typeof opts.dataRaw === "string" ? opts.dataRaw : undefined,
      dataBinary: typeof opts.dataBinary === "string" ? opts.dataBinary : undefined,
      request: typeof opts.request === "string" ? opts.request : undefined,
      output: typeof opts.output === "string" ? opts.output : undefined,
      include: opts.include === true,
      head: opts.head === true,
      silent: opts.silent === true,
      fail: opts.fail === true,
      location: opts.location === true,
      insecure: opts.insecure === true,
      maxTime:
        typeof opts.maxTime === "number" && !Number.isNaN(opts.maxTime) ? opts.maxTime : undefined,
    });
  });

program.parseAsync(process.argv).catch((err) => exitWithError(err));
