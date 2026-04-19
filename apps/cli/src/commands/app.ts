// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate app` — manage the pinned application for the active CLI
 * profile. Counterpart to the `appId` written at `appstrate login` time
 * (issue #217): lets users re-pin, create, or inspect their application
 * without re-running the device flow.
 *
 * Mirror of `./org.ts` — the command family, wiring conventions, and
 * interactive-picker semantics are identical so adding a third layer
 * (if ever needed) would follow the same rails.
 *
 * Subcommands:
 *   app list          — enumerate apps in the pinned org
 *   app switch [ref]  — re-pin (interactive if no arg)
 *   app current       — print pinned app id (scripts / prompts)
 *   app create [name] — create + auto-pin
 */

import { resolveActiveProfile, requireLoggedIn, updateProfile } from "../lib/config.ts";
import {
  listApplications,
  createApplication,
  resolveApplicationRef,
  type Application,
} from "../lib/applications.ts";
import { askText, select, exitWithError } from "../lib/ui.ts";

export interface AppBaseOptions {
  profile?: string;
}

export interface AppSwitchOptions extends AppBaseOptions {
  /** Positional `[id]` — when absent, use interactive picker. */
  ref?: string;
}

export interface AppCreateOptions extends AppBaseOptions {
  /** Positional `[name]` — when absent, prompt interactively. */
  name?: string;
}

export interface AppCommandDeps {
  /** Return null when the picker cannot run (e.g. non-TTY). */
  pickApp?: (apps: Application[], currentAppId?: string) => Promise<Application | null>;
  /** Return null when the prompt cannot run. */
  promptCreateApp?: () => Promise<{ name: string } | null>;
}

const defaultDeps: Required<AppCommandDeps> = {
  pickApp: async (apps: Application[], currentAppId?: string): Promise<Application | null> => {
    if (!process.stdin.isTTY) return null;
    const current = currentAppId ? apps.find((a) => a.id === currentAppId) : undefined;
    return select<Application>(
      "Select an application",
      apps.map((a) => {
        const suffixes: string[] = [];
        if (a.isDefault) suffixes.push("default");
        if (a.id === currentAppId) suffixes.push("current");
        const suffix = suffixes.length > 0 ? ` (${suffixes.join(", ")})` : "";
        return {
          value: a,
          label: `${a.name}${suffix}`,
          hint: a.id,
        };
      }),
      current,
    );
  },
  promptCreateApp: async (): Promise<{ name: string } | null> => {
    if (!process.stdin.isTTY) return null;
    const name = await askText("Application name");
    return { name };
  },
};

export async function appListCommand(opts: AppBaseOptions): Promise<void> {
  const { profileName, profile } = await resolveActiveProfile(opts.profile);
  requireLoggedIn(profileName, profile);

  try {
    const apps = await listApplications(profileName);
    if (apps.length === 0) {
      process.stdout.write("(no applications)\n");
      return;
    }
    for (const a of apps) {
      const marker = a.id === profile.appId ? "*" : " ";
      const def = a.isDefault ? " [default]" : "";
      process.stdout.write(`${marker} ${a.name.padEnd(24)}  ${a.id}${def}\n`);
    }
  } catch (err) {
    exitWithError(err);
  }
}

export async function appCurrentCommand(opts: AppBaseOptions): Promise<void> {
  const { profile } = await resolveActiveProfile(opts.profile);
  if (!profile) {
    process.stderr.write("Not logged in. Run: appstrate login\n");
    process.exit(1);
  }
  if (!profile.appId) {
    process.stderr.write("No application pinned. Run: appstrate app switch\n");
    process.exit(1);
  }
  process.stdout.write(`${profile.appId}\n`);
}

export async function appSwitchCommand(
  opts: AppSwitchOptions,
  deps: AppCommandDeps = {},
): Promise<void> {
  const { profileName, profile } = await resolveActiveProfile(opts.profile);
  requireLoggedIn(profileName, profile);
  const picker = { ...defaultDeps, ...deps };

  try {
    const apps = await listApplications(profileName);
    if (apps.length === 0) {
      process.stderr.write("No applications — run `appstrate app create <name>` to create one.\n");
      process.exit(1);
    }

    let chosen: Application;
    if (opts.ref !== undefined) {
      chosen = resolveApplicationRef(apps, opts.ref);
    } else {
      const picked = await picker.pickApp(apps, profile.appId);
      if (!picked) {
        process.stderr.write(
          "Cannot prompt in non-TTY — pass an id: `appstrate app switch <id>`.\n",
        );
        process.exit(1);
      }
      chosen = picked;
    }

    await updateProfile(profileName, { appId: chosen.id });
    process.stdout.write(`Pinned "${chosen.name}" (${chosen.id}) on profile "${profileName}".\n`);
  } catch (err) {
    exitWithError(err);
  }
}

export async function appCreateCommand(
  opts: AppCreateOptions,
  deps: AppCommandDeps = {},
): Promise<void> {
  const { profileName, profile } = await resolveActiveProfile(opts.profile);
  requireLoggedIn(profileName, profile);
  const picker = { ...defaultDeps, ...deps };

  try {
    let name: string;
    if (opts.name !== undefined) {
      name = opts.name;
    } else {
      const prompted = await picker.promptCreateApp();
      if (!prompted) {
        process.stderr.write(
          "Cannot prompt in non-TTY — pass a name: `appstrate app create <name>`.\n",
        );
        process.exit(1);
      }
      name = prompted.name;
    }
    const created = await createApplication(profileName, name);
    await updateProfile(profileName, { appId: created.id });
    process.stdout.write(
      `Created "${created.name}" (${created.id}) and pinned it on profile "${profileName}".\n`,
    );
  } catch (err) {
    exitWithError(err);
  }
}
