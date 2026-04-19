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
import { exitWithError } from "./lib/ui.ts";
import { CLI_VERSION } from "./lib/version.ts";

// Defense in depth: restore cooked mode on exit. `@clack/prompts`
// sets raw mode via `process.stdin.setRawMode(true)` and relies on its
// own listeners to flip it back — if the process dies while a prompt
// is open (crash, SIGINT, the Bun macOS keypress regression in #199)
// the terminal is left unusable and only `reset` fixes it. Registering
// a cooked-mode restore on every exit path is cheap and catches the
// edge cases clack's own cleanup misses. Must be registered BEFORE the
// error handlers below so a synchronous crash in startup still runs it.
const restoreCookedMode = (): void => {
  try {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
  } catch {
    // Intentional swallow: restoration is best-effort. If stdin was
    // already detached (exec into another process, stream closed) the
    // call throws — but we're already on the exit path, so nothing we
    // do here matters except not masking the real exit code.
  }
};
process.on("exit", restoreCookedMode);
process.on("SIGINT", () => {
  restoreCookedMode();
  process.exit(130);
});
process.on("SIGTERM", () => {
  restoreCookedMode();
  process.exit(143);
});
process.on("SIGHUP", () => {
  restoreCookedMode();
  process.exit(129);
});

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
  .option(
    "-y, --yes",
    "Skip all prompts and accept smart defaults (Docker-aware tier from #180, default directory, auto-start dev server). Required for curl|bash, CI, Dockerfile RUN, cloud-init. Equivalent to APPSTRATE_YES=1. Per-field flags (--tier, --dir, --port) still override the defaults.",
  )
  .action(async (opts) => {
    // Env var fallback mirrors Homebrew's NONINTERACTIVE=1 / rustup-init's
    // RUSTUP_INIT_SKIP_PATH_CHECK pattern — useful for Dockerfile `ENV` and
    // cloud-init `environment:` blocks where appending argv is awkward.
    const autoConfirm = opts.yes === true || process.env.APPSTRATE_YES === "1";
    await installCommand({
      tier: typeof opts.tier === "string" ? opts.tier : undefined,
      dir: typeof opts.dir === "string" ? opts.dir : undefined,
      port: typeof opts.port === "string" ? opts.port : undefined,
      minioConsolePort:
        typeof opts.minioConsolePort === "string" ? opts.minioConsolePort : undefined,
      force: opts.force === true,
      autoConfirm,
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

program.parseAsync(process.argv).catch((err) => exitWithError(err));
