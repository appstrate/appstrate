// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate connections …` — manage the user's connection profiles +
 * inspect existing OAuth/API-key connections.
 *
 * The pinned `connectionProfileId` lives on the CLI profile alongside
 * `applicationId`/`orgId` (TOML, see `lib/config.ts`). Switching it makes every
 * subsequent `appstrate run` use that profile by default. Per-call
 * overrides go through the `--connection-profile` flag on `run`.
 *
 * Subcommands:
 *   connections list                 — list active connections
 *   connections profile list         — list profiles
 *   connections profile current      — print pinned profile id
 *   connections profile switch [ref] — re-pin (interactive picker if no arg)
 *   connections profile create <name>
 */

import { resolveActiveProfile, requireLoggedIn, updateProfile } from "../lib/config.ts";
import {
  createConnectionProfile,
  listConnectionProfiles,
  listUserConnections,
  resolveConnectionProfileRef,
  type ConnectionProfile,
} from "../lib/connection-profiles.ts";
import { askText, select, exitWithError } from "../lib/ui.ts";

export interface ConnectionsBaseOptions {
  profile?: string;
}

export interface ConnectionsSwitchOptions extends ConnectionsBaseOptions {
  ref?: string;
}

export interface ConnectionsCreateOptions extends ConnectionsBaseOptions {
  name?: string;
}

export interface ConnectionsCommandDeps {
  pickProfile?: (
    profiles: ConnectionProfile[],
    currentId?: string,
  ) => Promise<ConnectionProfile | null>;
  promptCreateProfile?: () => Promise<{ name: string } | null>;
}

const defaultDeps: Required<ConnectionsCommandDeps> = {
  pickProfile: async (profiles, currentId) => {
    if (!process.stdin.isTTY) return null;
    const current = currentId ? profiles.find((p) => p.id === currentId) : undefined;
    return select<ConnectionProfile>(
      "Select a connection profile",
      profiles.map((p) => {
        const suffixes: string[] = [];
        if (p.isDefault) suffixes.push("default");
        if (p.id === currentId) suffixes.push("current");
        const suffix = suffixes.length > 0 ? ` (${suffixes.join(", ")})` : "";
        return {
          value: p,
          label: `${p.name}${suffix}`,
          hint: `${p.connectionCount} connection(s) · ${p.id}`,
        };
      }),
      current,
    );
  },
  promptCreateProfile: async () => {
    if (!process.stdin.isTTY) return null;
    const name = await askText("Connection profile name");
    return { name };
  },
};

export async function connectionsListCommand(opts: ConnectionsBaseOptions): Promise<void> {
  const { profileName, profile } = await resolveActiveProfile(opts.profile);
  requireLoggedIn(profileName, profile);

  try {
    const conns = await listUserConnections(profileName);
    if (conns.length === 0) {
      process.stdout.write("(no connections)\n");
      return;
    }
    for (const c of conns) {
      const status = c.status === "connected" ? "✓" : c.status;
      process.stdout.write(
        `${status.padEnd(8)} ${c.providerId.padEnd(28)} profile=${c.profileName}\n`,
      );
    }
  } catch (err) {
    exitWithError(err);
  }
}

export async function connectionsProfileListCommand(opts: ConnectionsBaseOptions): Promise<void> {
  const { profileName, profile } = await resolveActiveProfile(opts.profile);
  requireLoggedIn(profileName, profile);

  try {
    const profiles = await listConnectionProfiles(profileName);
    if (profiles.length === 0) {
      process.stdout.write("(no profiles)\n");
      return;
    }
    for (const p of profiles) {
      const marker = p.id === profile.connectionProfileId ? "*" : " ";
      const def = p.isDefault ? " [default]" : "";
      process.stdout.write(
        `${marker} ${p.name.padEnd(24)}  ${p.id}  (${p.connectionCount} conn)${def}\n`,
      );
    }
  } catch (err) {
    exitWithError(err);
  }
}

export async function connectionsProfileCurrentCommand(
  opts: ConnectionsBaseOptions,
): Promise<void> {
  const { profile } = await resolveActiveProfile(opts.profile);
  if (!profile) {
    process.stderr.write("Not logged in. Run: appstrate login\n");
    process.exit(1);
  }
  if (!profile.connectionProfileId) {
    process.stderr.write(
      "No connection profile pinned. Run: appstrate connections profile switch\n",
    );
    process.exit(1);
  }
  process.stdout.write(`${profile.connectionProfileId}\n`);
}

export async function connectionsProfileSwitchCommand(
  opts: ConnectionsSwitchOptions,
  deps: ConnectionsCommandDeps = {},
): Promise<void> {
  const { profileName, profile } = await resolveActiveProfile(opts.profile);
  requireLoggedIn(profileName, profile);
  const picker = { ...defaultDeps, ...deps };

  try {
    const profiles = await listConnectionProfiles(profileName);
    if (profiles.length === 0) {
      process.stderr.write(
        "No connection profiles — run `appstrate connections profile create <name>` to create one.\n",
      );
      process.exit(1);
    }

    let chosen: ConnectionProfile;
    if (opts.ref !== undefined) {
      chosen = resolveConnectionProfileRef(profiles, opts.ref);
    } else {
      const picked = await picker.pickProfile(profiles, profile.connectionProfileId);
      if (!picked) {
        process.stderr.write(
          "Cannot prompt in non-TTY — pass a ref: `appstrate connections profile switch <id|name>`.\n",
        );
        process.exit(1);
      }
      chosen = picked;
    }

    await updateProfile(profileName, { connectionProfileId: chosen.id });
    process.stdout.write(
      `Pinned connection profile "${chosen.name}" (${chosen.id}) on profile "${profileName}".\n`,
    );
  } catch (err) {
    exitWithError(err);
  }
}

export async function connectionsProfileCreateCommand(
  opts: ConnectionsCreateOptions,
  deps: ConnectionsCommandDeps = {},
): Promise<void> {
  const { profileName, profile } = await resolveActiveProfile(opts.profile);
  requireLoggedIn(profileName, profile);
  const picker = { ...defaultDeps, ...deps };

  try {
    let name: string;
    if (opts.name !== undefined) {
      name = opts.name;
    } else {
      const prompted = await picker.promptCreateProfile();
      if (!prompted) {
        process.stderr.write(
          "Cannot prompt in non-TTY — pass a name: `appstrate connections profile create <name>`.\n",
        );
        process.exit(1);
      }
      name = prompted.name;
    }
    const created = await createConnectionProfile(profileName, name);
    await updateProfile(profileName, { connectionProfileId: created.id });
    process.stdout.write(
      `Created "${created.name}" (${created.id}) and pinned it on profile "${profileName}".\n`,
    );
  } catch (err) {
    exitWithError(err);
  }
}
