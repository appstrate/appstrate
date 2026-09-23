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
 * the first command word — read the way commander reads them. `valueFlags` are
 * the program options that REQUIRE a value (`-p <name>`): the next argument is
 * that value, not a command word, even when it looks like one. A short cluster
 * is read left to right as commander splits it: `-Vp` asks for the version,
 * `-pV` names the profile `V`.
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

/**
 * The program's options that require a value, by every spelling commander
 * accepts. An optional value (`[n]`) is left out: commander never takes a
 * following `-…` argument as one, so it cannot hide a `--version`.
 */
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
 * List `-V, --version` in the program's help, where `.version()` used to put
 * it, without registering an option commander would then parse everywhere.
 *
 * Only while help is being rendered: commander also reads `visibleOptions` to
 * suggest a fix for an unknown option, and must not answer a refused
 * `pull … --version` with "Did you mean --version?".
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
