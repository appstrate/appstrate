// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate space` — manage the pinned space for the active CLI
 * profile. Counterpart to the `spaceId` written at `appstrate login` time
 * (issue #217): lets users re-pin, create, or inspect their space
 * without re-running the device flow.
 *
 * Mirror of `./org.ts` — the command family, wiring conventions, and
 * interactive-picker semantics are identical so adding a third layer
 * (if ever needed) would follow the same rails.
 *
 * Mirroring extends to the IO seam: every subcommand takes a trailing
 * `io: CommandIO = DEFAULT_IO` (after `deps`, since `list` and `current`
 * have no `deps`), so tests capture output in a sink they own instead of
 * reassigning the process-wide streams — issue #1180.
 *
 * Subcommands:
 *   space list          — enumerate spaces in the pinned org
 *   space switch [ref]  — re-pin (interactive if no arg)
 *   space current       — print pinned space id (scripts / prompts)
 *   space create [name] — create + auto-pin
 */

import { resolveActiveProfile, requireLoggedIn, updateProfile } from "../lib/config.ts";
import { listSpaces, createSpace, resolveSpaceRef, type Space } from "../lib/spaces.ts";
import { askText, select, exitWithError } from "../lib/ui.ts";
import { DEFAULT_IO, type CommandIO } from "../lib/io.ts";

interface SpaceBaseOptions {
  profile?: string;
}

interface SpaceSwitchOptions extends SpaceBaseOptions {
  /** Positional `[id]` — when absent, use interactive picker. */
  ref?: string;
}

interface SpaceCreateOptions extends SpaceBaseOptions {
  /** Positional `[name]` — when absent, prompt interactively. */
  name?: string;
}

interface SpaceCommandDeps {
  /** Return null when the picker cannot run (e.g. non-TTY). */
  pickSpace?: (spaces: Space[], currentSpaceId?: string) => Promise<Space | null>;
  /** Return null when the prompt cannot run. */
  promptCreateSpace?: () => Promise<{ name: string } | null>;
}

const defaultDeps: Required<SpaceCommandDeps> = {
  pickSpace: async (spaces: Space[], currentSpaceId?: string): Promise<Space | null> => {
    if (!process.stdin.isTTY) return null;
    const current = currentSpaceId ? spaces.find((s) => s.id === currentSpaceId) : undefined;
    return select<Space>(
      "Select a space",
      spaces.map((s) => {
        const suffixes: string[] = [];
        if (s.isDefault) suffixes.push("default");
        if (s.id === currentSpaceId) suffixes.push("current");
        const suffix = suffixes.length > 0 ? ` (${suffixes.join(", ")})` : "";
        return {
          value: s,
          label: `${s.name}${suffix}`,
          hint: s.id,
        };
      }),
      current,
    );
  },
  promptCreateSpace: async (): Promise<{ name: string } | null> => {
    if (!process.stdin.isTTY) return null;
    const name = await askText("Space name");
    return { name };
  },
};

export async function spaceListCommand(
  opts: SpaceBaseOptions,
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const { profileName, profile } = await resolveActiveProfile(opts.profile);
  requireLoggedIn(profileName, profile, io);

  try {
    const spaces = await listSpaces(profileName);
    if (spaces.length === 0) {
      io.stdout.write("(no spaces)\n");
      return;
    }
    for (const s of spaces) {
      const marker = s.id === profile.spaceId ? "*" : " ";
      const def = s.isDefault ? " [default]" : "";
      io.stdout.write(`${marker} ${s.name.padEnd(24)}  ${s.id}${def}\n`);
    }
  } catch (err) {
    // `io` is forwarded so the terminal error and the exit go to the
    // caller's sink; the default would fire the real `process.exit`.
    exitWithError(err, io);
  }
}

export async function spaceCurrentCommand(
  opts: SpaceBaseOptions,
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const { profile } = await resolveActiveProfile(opts.profile);
  if (!profile) {
    io.stderr.write("Not logged in. Run: appstrate login\n");
    io.exit(1);
  }
  if (!profile.spaceId) {
    io.stderr.write("No space pinned. Run: appstrate space switch\n");
    io.exit(1);
  }
  io.stdout.write(`${profile.spaceId}\n`);
}

export async function spaceSwitchCommand(
  opts: SpaceSwitchOptions,
  deps: SpaceCommandDeps = {},
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const { profileName, profile } = await resolveActiveProfile(opts.profile);
  requireLoggedIn(profileName, profile, io);
  const picker = { ...defaultDeps, ...deps };

  try {
    const spaces = await listSpaces(profileName);
    if (spaces.length === 0) {
      io.stderr.write("No spaces — run `appstrate space create <name>` to create one.\n");
      io.exit(1);
    }

    let chosen: Space;
    if (opts.ref !== undefined) {
      chosen = resolveSpaceRef(spaces, opts.ref);
    } else {
      const picked = await picker.pickSpace(spaces, profile.spaceId);
      if (!picked) {
        io.stderr.write("Cannot prompt in non-TTY — pass an id: `appstrate space switch <id>`.\n");
        io.exit(1);
      }
      chosen = picked;
    }

    await updateProfile(profileName, { spaceId: chosen.id });
    io.stdout.write(`Pinned "${chosen.name}" (${chosen.id}) on profile "${profileName}".\n`);
  } catch (err) {
    exitWithError(err, io);
  }
}

export async function spaceCreateCommand(
  opts: SpaceCreateOptions,
  deps: SpaceCommandDeps = {},
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const { profileName, profile } = await resolveActiveProfile(opts.profile);
  requireLoggedIn(profileName, profile, io);
  const picker = { ...defaultDeps, ...deps };

  try {
    let name: string;
    if (opts.name !== undefined) {
      name = opts.name;
    } else {
      const prompted = await picker.promptCreateSpace();
      if (!prompted) {
        io.stderr.write(
          "Cannot prompt in non-TTY — pass a name: `appstrate space create <name>`.\n",
        );
        io.exit(1);
      }
      name = prompted.name;
    }
    const created = await createSpace(profileName, name);
    await updateProfile(profileName, { spaceId: created.id });
    io.stdout.write(
      `Created "${created.name}" (${created.id}) and pinned it on profile "${profileName}".\n`,
    );
  } catch (err) {
    exitWithError(err, io);
  }
}
