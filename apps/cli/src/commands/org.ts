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
 *
 * Cascade invariant (issue #217): the pinned `applicationId` is always scoped to
 * the pinned `orgId`. `org switch` and `org create` therefore clear the
 * stale app pin and re-pin the new org's default application in the same
 * atomic operation — otherwise the next `appstrate api` call would 404
 * with "Application not found in this organization".
 */

import { resolveActiveProfile, requireLoggedIn, updateProfile } from "../lib/config.ts";
import { listOrgs, createOrg, resolveOrgRef, type Org } from "../lib/orgs.ts";
import { listApplications, findDefaultApplication, type Application } from "../lib/applications.ts";
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
  const { profileName, profile } = await resolveActiveProfile(opts.profile);
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
  const { profile } = await resolveActiveProfile(opts.profile);
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
  const { profileName, profile } = await resolveActiveProfile(opts.profile);
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

    // Clear the stale app pin first: it belongs to the previous org and
    // would immediately 404 on the next app-scoped call. Re-pin the new
    // org's default app in the same commit below.
    await updateProfile(profileName, { orgId: chosen.id, applicationId: undefined });
    const repinned = await repinAppAfterOrgChange(profileName);
    const appSuffix = repinned ? ` / app "${repinned.name}" (${repinned.id})` : "";
    process.stdout.write(
      `Pinned "${chosen.name}" (${chosen.id})${appSuffix} on profile "${profileName}".\n`,
    );
  } catch (err) {
    exitWithError(err);
  }
}

export async function orgCreateCommand(
  opts: OrgCreateOptions,
  deps: OrgCommandDeps = {},
): Promise<void> {
  const { profileName, profile } = await resolveActiveProfile(opts.profile);
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
    // Server auto-provisions a default application on org creation — clear
    // any stale app pin from the previous org and re-pin the new default.
    await updateProfile(profileName, { orgId: created.id, applicationId: undefined });
    const repinned = await repinAppAfterOrgChange(profileName);
    const appSuffix = repinned ? ` / app "${repinned.name}" (${repinned.id})` : "";
    process.stdout.write(
      `Created "${created.name}" (${created.id})${appSuffix} and pinned it on profile "${profileName}".\n`,
    );
  } catch (err) {
    exitWithError(err);
  }
}

/**
 * After the org pin changes, pick the new org's default application
 * and pin it on the profile. Returns the pinned app, or null when there
 * is nothing sensible to pin (no apps, or ≥2 without a default) — the
 * command continues regardless; the user can run `app switch` manually.
 *
 * Swallows network errors: the org pin already succeeded and forcing the
 * user to re-run `org switch` over a transient `/api/applications` blip
 * would be a worse UX than an unpinned app.
 */
async function repinAppAfterOrgChange(profileName: string): Promise<Application | null> {
  try {
    const apps = await listApplications(profileName);
    if (apps.length === 0) return null;
    const chosen = findDefaultApplication(apps) ?? (apps.length === 1 ? apps[0]! : null);
    if (!chosen) return null;
    await updateProfile(profileName, { applicationId: chosen.id });
    return chosen;
  } catch {
    return null;
  }
}
