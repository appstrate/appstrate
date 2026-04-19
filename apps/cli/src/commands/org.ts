// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate org` — manage the pinned organization for the active CLI
 * profile. Counterpart to the `orgId` written at `appstrate login` time
 * (issue #209): lets users re-pin, create, or inspect their org without
 * re-running the device flow.
 *
 * Subcommands:
 *   org list          — enumerate orgs the profile has access to
 *   org switch [ref]  — re-pin (interactive if no arg)
 *   org current       — print pinned org id (scripts / prompts)
 *   org create [name] — create + auto-pin
 */

import { readConfig, resolveProfileName, setProfile, type Profile } from "../lib/config.ts";
import { listOrgs, createOrg, resolveOrgRef, type Org } from "../lib/orgs.ts";
import { askText, select, exitWithError } from "../lib/ui.ts";

export interface OrgBaseOptions {
  profile?: string;
}

export interface OrgSwitchOptions extends OrgBaseOptions {
  /** Positional `[id-or-slug]` — when absent, use interactive picker. */
  ref?: string;
}

export interface OrgCreateOptions extends OrgBaseOptions {
  /** Positional `[name]` — when absent, prompt interactively. */
  name?: string;
  /** `--slug <slug>` (optional override — server derives from name if unset). */
  slug?: string;
}

export interface OrgCommandDeps {
  /** Return null when the picker cannot run (e.g. non-TTY). */
  pickOrg?: (orgs: Org[], currentOrgId?: string) => Promise<Org | null>;
  /** Return null when the prompt cannot run. */
  promptCreateOrg?: () => Promise<{ name: string; slug?: string } | null>;
}

const defaultDeps: Required<OrgCommandDeps> = {
  pickOrg: async (orgs: Org[], currentOrgId?: string): Promise<Org | null> => {
    if (!process.stdin.isTTY) return null;
    const current = currentOrgId ? orgs.find((o) => o.id === currentOrgId) : undefined;
    return select<Org>(
      "Select an organization",
      orgs.map((o) => ({
        value: o,
        label: `${o.name} — ${o.slug}${o.id === currentOrgId ? " (current)" : ""}`,
        hint: o.id,
      })),
      current,
    );
  },
  promptCreateOrg: async (): Promise<{ name: string; slug?: string } | null> => {
    if (!process.stdin.isTTY) return null;
    const name = await askText("Organization name");
    const slugRaw = await askText("Slug (optional — leave blank to auto-generate)", "");
    const slug = slugRaw.trim();
    return slug.length > 0 ? { name, slug } : { name };
  },
};

export async function orgListCommand(opts: OrgBaseOptions): Promise<void> {
  const { profileName, profile } = await resolveActive(opts.profile);
  requireLoggedIn(profileName, profile);

  try {
    const orgs = await listOrgs(profileName);
    if (orgs.length === 0) {
      process.stdout.write("(no organizations)\n");
      return;
    }
    for (const o of orgs) {
      const marker = o.id === profile.orgId ? "*" : " ";
      process.stdout.write(`${marker} ${o.slug.padEnd(24)}  ${o.id}  ${o.name}\n`);
    }
  } catch (err) {
    exitWithError(err);
  }
}

export async function orgCurrentCommand(opts: OrgBaseOptions): Promise<void> {
  const { profile } = await resolveActive(opts.profile);
  if (!profile) {
    process.stderr.write("Not logged in. Run: appstrate login\n");
    process.exit(1);
  }
  if (!profile.orgId) {
    process.stderr.write("No organization pinned. Run: appstrate org switch\n");
    process.exit(1);
  }
  process.stdout.write(`${profile.orgId}\n`);
}

export async function orgSwitchCommand(
  opts: OrgSwitchOptions,
  deps: OrgCommandDeps = {},
): Promise<void> {
  const { profileName, profile } = await resolveActive(opts.profile);
  requireLoggedIn(profileName, profile);
  const picker = { ...defaultDeps, ...deps };

  try {
    const orgs = await listOrgs(profileName);
    if (orgs.length === 0) {
      process.stderr.write("No organizations — run `appstrate org create <name>` to create one.\n");
      process.exit(1);
    }

    let chosen: Org;
    if (opts.ref !== undefined) {
      chosen = resolveOrgRef(orgs, opts.ref);
    } else {
      const picked = await picker.pickOrg(orgs, profile.orgId);
      if (!picked) {
        process.stderr.write(
          "Cannot prompt in non-TTY — pass an id or slug: `appstrate org switch <id-or-slug>`.\n",
        );
        process.exit(1);
      }
      chosen = picked;
    }

    await setProfile(profileName, { ...profile, orgId: chosen.id });
    process.stdout.write(`Pinned "${chosen.name}" (${chosen.id}) on profile "${profileName}".\n`);
  } catch (err) {
    exitWithError(err);
  }
}

export async function orgCreateCommand(
  opts: OrgCreateOptions,
  deps: OrgCommandDeps = {},
): Promise<void> {
  const { profileName, profile } = await resolveActive(opts.profile);
  requireLoggedIn(profileName, profile);
  const picker = { ...defaultDeps, ...deps };

  try {
    let input: { name: string; slug?: string };
    if (opts.name !== undefined) {
      input = { name: opts.name };
      if (opts.slug !== undefined) input.slug = opts.slug;
    } else {
      const prompted = await picker.promptCreateOrg();
      if (!prompted) {
        process.stderr.write(
          "Cannot prompt in non-TTY — pass a name: `appstrate org create <name>`.\n",
        );
        process.exit(1);
      }
      input = prompted;
    }
    const created = await createOrg(profileName, input);
    await setProfile(profileName, { ...profile, orgId: created.id });
    process.stdout.write(
      `Created "${created.name}" (${created.id}) and pinned it on profile "${profileName}".\n`,
    );
  } catch (err) {
    exitWithError(err);
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

interface Active {
  profileName: string;
  profile: Profile | undefined;
}

async function resolveActive(explicit: string | undefined): Promise<Active> {
  const config = await readConfig();
  const profileName = resolveProfileName(explicit, config);
  return { profileName, profile: config.profiles[profileName] };
}

function requireLoggedIn(
  profileName: string,
  profile: Profile | undefined,
): asserts profile is Profile {
  if (!profile) {
    process.stderr.write(
      `Profile "${profileName}" not configured. Run: appstrate login --profile ${profileName}\n`,
    );
    process.exit(1);
  }
}
