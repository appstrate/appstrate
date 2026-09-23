// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate --version` is a top-level flag, and only there.
 *
 * Commander's `.version()` registers `-V, --version` as a PROGRAM option, and
 * program options are recognised anywhere on the line — which is what lets
 * `appstrate whoami --profile prod` work. A version flag registered that way
 * shadows every subcommand: `appstrate packages pull @s/n --version 1.0.0`
 * printed the CLI's version and exited 0 without pulling anything (#1516).
 *
 * So the flag is not a commander option. `cli.ts` asks {@link asksForVersion}
 * before commander parses; after a command word, `--version` is an option that
 * command does not declare, and commander refuses it like any unknown option.
 */

import { Help, Option, type Command } from "commander";

const VERSION_FLAGS: ReadonlySet<string> = new Set(["-V", "--version"]);

/**
 * True when `-V`/`--version` appears among the program's own options, before
 * the first command word. `valueFlags` are the program options that take a
 * value (`-p <name>`): that value is not a command word, even when it looks
 * like one.
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
  }
  return false;
}

/** The program's options that take a value, by every spelling commander accepts. */
export function valueFlagsOf(program: Command): Set<string> {
  const flags = new Set<string>();
  for (const option of program.options) {
    if (!option.required && !option.optional) continue;
    if (option.short) flags.add(option.short);
    if (option.long) flags.add(option.long);
  }
  return flags;
}

/**
 * List `-V, --version` in the program's help, where `.version()` used to put
 * it, without registering an option commander would then parse everywhere.
 */
export function showVersionFlagInHelp(program: Command): void {
  const versionOption = new Option("-V, --version", "output the version number");
  program.configureHelp({
    visibleOptions(cmd: Command): Option[] {
      const options = Help.prototype.visibleOptions.call(this, cmd);
      return cmd === program ? [versionOption, ...options] : options;
    },
  });
}
