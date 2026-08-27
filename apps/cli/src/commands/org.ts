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
 * Every subcommand takes a trailing `io: CommandIO = DEFAULT_IO`. It sits
 * after `deps` rather than on it because `list` and `current` have no
 * `deps` at all, and "io is always the last argument" is the only rule that
 * holds for all four. `cli.ts` passes neither, so production keeps writing
 * to the real streams; tests inject a per-test sink instead of swapping the
 * process-wide ones (issue #1180).
 *
 * Cascade invariant (issue #217): the pinned `spaceId` is always scoped to
 * the pinned `orgId`. `org switch` and `org create` therefore clear the
 * stale space pin and re-pin the new org's default space in the same
 * atomic operation — otherwise the next `appstrate api` call would 404
 * with "Space not found in this organization".
 */

import { resolveActiveProfile, requireLoggedIn, updateProfile } from "../lib/config.ts";
import { listOrgs, createOrg, resolveOrgRef, type Org } from "../lib/orgs.ts";
import { listSpaces, findDefaultSpace, type Space } from "../lib/spaces.ts";
import { askText, select, exitWithError } from "../lib/ui.ts";
import { DEFAULT_IO, type CommandIO } from "../lib/io.ts";

interface OrgBaseOptions {
  profile?: string;
}

interface OrgSwitchOptions extends OrgBaseOptions {
  /** Positional `[id-or-slug]` — when absent, use interactive picker. */
  ref?: string;
}

interface OrgCreateOptions extends OrgBaseOptions {
  /** Positional `[name]` — when absent, prompt interactively. */
  name?: string;
  /** `--slug <slug>` (optional override — server derives from name if unset). */
  slug?: string;
}

interface OrgCommandDeps {
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

export async function orgListCommand(
  opts: OrgBaseOptions,
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const { profileName, profile } = await resolveActiveProfile(opts.profile);
  requireLoggedIn(profileName, profile, io);

  try {
    const orgs = await listOrgs(profileName);
    if (orgs.length === 0) {
      io.stdout.write("(no organizations)\n");
      return;
    }
    for (const o of orgs) {
      const marker = o.id === profile.orgId ? "*" : " ";
      io.stdout.write(`${marker} ${o.slug.padEnd(24)}  ${o.id}  ${o.name}\n`);
    }
  } catch (err) {
    // `io` is forwarded so the terminal error and the exit go to the
    // caller's sink; the default would fire the real `process.exit`.
    exitWithError(err, io);
  }
}

export async function orgCurrentCommand(
  opts: OrgBaseOptions,
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const { profile } = await resolveActiveProfile(opts.profile);
  if (!profile) {
    io.stderr.write("Not logged in. Run: appstrate login\n");
    io.exit(1);
  }
  if (!profile.orgId) {
    io.stderr.write("No organization pinned. Run: appstrate org switch\n");
    io.exit(1);
  }
  io.stdout.write(`${profile.orgId}\n`);
}

export async function orgSwitchCommand(
  opts: OrgSwitchOptions,
  deps: OrgCommandDeps = {},
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const { profileName, profile } = await resolveActiveProfile(opts.profile);
  requireLoggedIn(profileName, profile, io);
  const picker = { ...defaultDeps, ...deps };

  try {
    const orgs = await listOrgs(profileName);
    if (orgs.length === 0) {
      io.stderr.write("No organizations — run `appstrate org create <name>` to create one.\n");
      io.exit(1);
    }

    let chosen: Org;
    if (opts.ref !== undefined) {
      chosen = resolveOrgRef(orgs, opts.ref);
    } else {
      const picked = await picker.pickOrg(orgs, profile.orgId);
      if (!picked) {
        io.stderr.write(
          "Cannot prompt in non-TTY — pass an id or slug: `appstrate org switch <id-or-slug>`.\n",
        );
        io.exit(1);
      }
      chosen = picked;
    }

    // Clear the stale space pin first: it belongs to the previous org and
    // would immediately 404 on the next space-scoped call. Re-pin the new
    // org's default space in the same commit below.
    await updateProfile(profileName, { orgId: chosen.id, spaceId: undefined });
    const repinned = await repinSpaceAfterOrgChange(profileName);
    const spaceSuffix = repinned ? ` / space "${repinned.name}" (${repinned.id})` : "";
    io.stdout.write(
      `Pinned "${chosen.name}" (${chosen.id})${spaceSuffix} on profile "${profileName}".\n`,
    );
  } catch (err) {
    exitWithError(err, io);
  }
}

export async function orgCreateCommand(
  opts: OrgCreateOptions,
  deps: OrgCommandDeps = {},
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const { profileName, profile } = await resolveActiveProfile(opts.profile);
  requireLoggedIn(profileName, profile, io);
  const picker = { ...defaultDeps, ...deps };

  try {
    let input: { name: string; slug?: string };
    if (opts.name !== undefined) {
      input = { name: opts.name };
      if (opts.slug !== undefined) input.slug = opts.slug;
    } else {
      const prompted = await picker.promptCreateOrg();
      if (!prompted) {
        io.stderr.write("Cannot prompt in non-TTY — pass a name: `appstrate org create <name>`.\n");
        io.exit(1);
      }
      input = prompted;
    }
    const created = await createOrg(profileName, input);
    // Server auto-provisions a default space on org creation — clear
    // any stale space pin from the previous org and re-pin the new default.
    await updateProfile(profileName, { orgId: created.id, spaceId: undefined });
    const repinned = await repinSpaceAfterOrgChange(profileName);
    const spaceSuffix = repinned ? ` / space "${repinned.name}" (${repinned.id})` : "";
    io.stdout.write(
      `Created "${created.name}" (${created.id})${spaceSuffix} and pinned it on profile "${profileName}".\n`,
    );
  } catch (err) {
    exitWithError(err, io);
  }
}

/**
 * After the org pin changes, pick the new org's default space
 * and pin it on the profile. Returns the pinned space, or null when there
 * is nothing sensible to pin (no spaces, or ≥2 without a default) — the
 * command continues regardless; the user can run `space switch` manually.
 *
 * Swallows network errors: the org pin already succeeded and forcing the
 * user to re-run `org switch` over a transient `/api/spaces` blip
 * would be a worse UX than an unpinned space.
 */
async function repinSpaceAfterOrgChange(profileName: string): Promise<Space | null> {
  try {
    const spaces = await listSpaces(profileName);
    if (spaces.length === 0) return null;
    const chosen = findDefaultSpace(spaces) ?? (spaces.length === 1 ? spaces[0]! : null);
    if (!chosen) return null;
    await updateProfile(profileName, { spaceId: chosen.id });
    return chosen;
  } catch {
    return null;
  }
}
