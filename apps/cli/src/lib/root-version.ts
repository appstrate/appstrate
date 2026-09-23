// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate -V/--version`, answered before the command word only (#1516).
 * Registered with `.version()` it would be a program option, which commander
 * parses anywhere on the line, shadowing a subcommand's own `--version`.
 */

import { Help, Option, type Command } from "commander";

const VERSION_FLAGS: ReadonlySet<string> = new Set(["-V", "--version"]);

/**
 * Whether the program's own options, read as commander reads them, ask for the
 * version: `valueFlags` skip their value, and a short cluster is split left to
 * right (`-Vp` asks, `-pV` names a profile).
 */
export function asksForVersion(args: readonly string[], valueFlags: ReadonlySet<string>): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return false;
    if (VERSION_FLAGS.has(arg)) return true;
    if (valueFlags.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") return false;
    if (!arg.startsWith("--") && arg.length > 2 && arg[1] === "V") return true;
  }
  return false;
}

/** Every spelling of the program options that REQUIRE a value — an optional one never takes `-…`. */
export function valueFlagsOf(program: Command): Set<string> {
  const flags = new Set<string>();
  for (const option of program.options) {
    if (!option.required) continue;
    if (option.short) flags.add(option.short);
    if (option.long) flags.add(option.long);
  }
  return flags;
}

/**
 * List `-V, --version` in the top-level help, and only while help renders:
 * commander also reads `visibleOptions` to suggest a fix for an unknown option.
 */
export function showVersionFlagInHelp(program: Command): void {
  const versionOption = new Option("-V, --version", "output the version number");
  const rendering = new WeakSet<Help>();
  program.configureHelp({
    formatHelp(this: Help, cmd: Command, helper: Help): string {
      rendering.add(helper);
      try {
        return Help.prototype.formatHelp.call(this, cmd, helper);
      } finally {
        rendering.delete(helper);
      }
    },
    visibleOptions(this: Help, cmd: Command): Option[] {
      const options = Help.prototype.visibleOptions.call(this, cmd);
      return cmd === program && rendering.has(this) ? [versionOption, ...options] : options;
    },
  });
}
