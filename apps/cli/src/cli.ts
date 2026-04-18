#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate` — official Appstrate CLI entry point.
 *
 * Two commands in v0 (ADR-006 Phase 2):
 *   - `appstrate login`: RFC 8628 device-flow against an instance.
 *   - `appstrate logout`: revoke the session + wipe local storage.
 *   - `appstrate whoami`: print the active profile's identity.
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
import { exitWithError } from "./lib/ui.ts";

// Catch stray unhandled rejections + uncaughts before Bun's default
// stack-trace dump kicks in — commands are async and may throw after
// commander's callback completes.
process.on("unhandledRejection", (err) => exitWithError(err));
process.on("uncaughtException", (err) => exitWithError(err));

const program = new Command();

program
  .name("appstrate")
  .description("Official CLI for the Appstrate platform")
  .version("0.0.0")
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
    "--force",
    "Bypass the 'another Compose project is already running under this name' preflight. Only use if you have already backed up the other install's data.",
  )
  .action(async (opts) => {
    await installCommand({
      tier: typeof opts.tier === "string" ? opts.tier : undefined,
      dir: typeof opts.dir === "string" ? opts.dir : undefined,
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

program.parseAsync(process.argv).catch((err) => exitWithError(err));
