// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate login` — interactive device-flow sign-in.
 *
 * Flow:
 *   1. Resolve profile name (flag → env → default).
 *   2. Ask for instance URL if not passed via `--instance`.
 *   3. POST /api/auth/device/code → receive user_code + verification URL.
 *   4. Print the code in the terminal + open the browser.
 *   5. Poll /api/auth/device/token until approval.
 *   6. Store the JWT access + rotating refresh pair in the keyring
 *      (issue #165); decode `sub` + `email` from the JWT payload
 *      (via `lib/jwt-identity.ts`) to capture userId + email;
 *      persist the profile in config.toml.
 *   7. Pin an organization on the profile so subsequent `X-Org-Id`-
 *      requiring routes (`/api/me`, `/api/agents`, …) work out of the
 *      box. Issue #209. Auto-pin on one org, interactive picker on
 *      many, offer inline creation on zero. Non-interactive escapes:
 *      `--org <id-or-slug>`, `--create-org <name>`, `--no-org`.
 */

import open from "open";
import {
  intro,
  outro,
  askText,
  select,
  spinner,
  formatUserCode,
  exitWithError,
} from "../lib/ui.ts";
import { readConfig, resolveProfileName, setProfile } from "../lib/config.ts";
import { saveTokens } from "../lib/keyring.ts";
import { startDeviceFlow, pollDeviceFlow } from "../lib/device-flow.ts";
import { normalizeInstance } from "../lib/instance-url.ts";
import { CLI_CLIENT_ID, CLI_SCOPE } from "../lib/cli-client.ts";
import { decodeAccessTokenIdentity } from "../lib/jwt-identity.ts";
import { listOrgs, createOrg, resolveOrgRef, type Org } from "../lib/orgs.ts";

export interface LoginOptions {
  profile?: string;
  instance?: string;
  /** `--org <id-or-slug>` — non-interactive pin, fails if no match. */
  org?: string;
  /** `--create-org <name>` — non-interactive inline creation + pin. */
  createOrg?: string;
  /** `--no-org` — explicitly skip the whole pin step. */
  noOrg?: boolean;
  deps?: LoginDeps;
}

/**
 * Dependency-injected prompt helpers so the login command is testable
 * without mock.module (banned per CLAUDE.md). Production paths bind to
 * the real `@clack/prompts` helpers in `lib/ui.ts`. Return `null` from
 * either hook to signal "user opted out / cannot prompt" — the caller
 * leaves `orgId` unset and prints a follow-up hint.
 */
export interface LoginDeps {
  /** Interactive picker when the user belongs to ≥2 orgs. */
  pickOrg?: (orgs: Org[]) => Promise<Org | null>;
  /** Prompt the user for a new org name + optional slug. */
  promptCreateOrg?: () => Promise<{ name: string; slug?: string } | null>;
}

const defaultDeps: Required<LoginDeps> = {
  pickOrg: async (orgs: Org[]): Promise<Org | null> => {
    if (!process.stdin.isTTY) {
      process.stdout.write(
        "Multiple organizations — pass --org <id-or-slug> to pin non-interactively.\n",
      );
      return null;
    }
    return select<Org>(
      "Select the organization to pin on this profile",
      orgs.map((o) => ({
        value: o,
        label: `${o.name} — ${o.slug}`,
        hint: o.id,
      })),
    );
  },
  promptCreateOrg: async (): Promise<{ name: string; slug?: string } | null> => {
    if (!process.stdin.isTTY) {
      process.stdout.write(
        "No organization yet on this account — run `appstrate org create <name>` to create one.\n",
      );
      return null;
    }
    const name = await askText("Organization name");
    const slugRaw = await askText("Slug (optional — leave blank to auto-generate)", "");
    const slug = slugRaw.trim();
    return slug.length > 0 ? { name, slug } : { name };
  },
};

export async function loginCommand(opts: LoginOptions): Promise<void> {
  const config = await readConfig();
  const profileName = resolveProfileName(opts.profile, config);

  intro(`Appstrate login — profile "${profileName}"`);

  const rawInstance =
    opts.instance ??
    (await askText(
      "Instance URL",
      config.profiles[profileName]?.instance ?? "http://localhost:3000",
    ));

  // Validate + strip trailing `/` up front. Throws `InsecureInstanceError`
  // if the user pointed at a non-loopback `http://` host without
  // `--insecure` / `APPSTRATE_INSECURE=1` — we surface that via
  // `exitWithError` like any other terminal failure below.
  let normalizedInstance: string;
  try {
    normalizedInstance = normalizeInstance(rawInstance);
  } catch (err) {
    exitWithError(err);
  }

  try {
    await runLogin(profileName, normalizedInstance, opts);
  } catch (err) {
    exitWithError(err);
  }
}

async function runLogin(profileName: string, instance: string, opts: LoginOptions): Promise<void> {
  // Step 1 — device code.
  const s = spinner();
  s.start("Requesting device code");
  const code = await startDeviceFlow(instance, CLI_CLIENT_ID, CLI_SCOPE);
  s.stop(`Code received — expires in ${Math.round(code.expiresIn / 60)}m`);

  const display = formatUserCode(code.userCode);

  // Step 2 — show the user what to do. Print outside the spinner so the
  // code remains visible even after the spinner rewinds the cursor.
  process.stdout.write(`\n  Visit: ${code.verificationUri}\n`);
  process.stdout.write(`  Code:  ${display}\n\n`);

  // Step 3 — open the browser on the complete URI (pre-fills user_code).
  // If `open` fails (headless SSH / no display), the printed URL + code
  // above keep the flow usable. Swallow the error silently.
  open(code.verificationUriComplete).catch(() => {});

  // Step 4 — poll until approval or terminal error.
  const pollSpinner = spinner();
  pollSpinner.start("Waiting for approval in your browser");
  const token = await pollDeviceFlow(instance, code.deviceCode, CLI_CLIENT_ID, {
    interval: code.interval,
    expiresIn: code.expiresIn,
  });
  pollSpinner.stop("Approved");

  // Step 5 — extract identity from the access token claims. The JWT
  // minted by /api/auth/cli/token carries `sub` (BA user id), `email`,
  // and `name` — everything the CLI needs to persist the profile. We
  // decode locally (base64url payload, no signature verification) because
  // the token was just obtained from an instance the user chose;
  // verification happens on every server request anyway. Decoding
  // locally also avoids the bootstrap problem: BA's /get-session only
  // reads session cookies, and /api/auth/* bypasses our OIDC bearer
  // strategy, so there is no endpoint that understands this JWT before
  // we have persisted org context.
  const identity = decodeAccessTokenIdentity(token.accessToken);

  // Step 6 — persist both the tokens and the profile in one pass.
  //
  // Issue #165: a 2.x server MUST issue both `refresh_token` and
  // `refresh_expires_in`. A missing `refresh_token` means pre-2.x;
  // a missing `refresh_expires_in` means a non-conforming proxy
  // stripped the field. Either way the CLI refuses the login rather
  // than fabricating an expiry — a hallucinated 30-day window would
  // mask a real protocol mismatch and leak into the keyring.
  if (!token.refreshToken) {
    throw new Error(
      "Server did not issue a refresh token — the instance may be running a pre-2.x Appstrate. " +
        "Upgrade the server, or use `--instance` to target a 2.x instance.",
    );
  }
  if (token.refreshExpiresIn === undefined) {
    throw new Error(
      "Server returned a refresh token without refresh_expires_in — the response is non-conforming. " +
        "Check the server version and any middleware transforming the /api/auth/cli/token response, then retry.",
    );
  }
  await saveTokens(profileName, {
    accessToken: token.accessToken,
    expiresAt: Date.now() + token.expiresIn * 1000,
    refreshToken: token.refreshToken,
    refreshExpiresAt: Date.now() + token.refreshExpiresIn * 1000,
  });
  await setProfile(profileName, {
    instance,
    userId: identity.userId,
    email: identity.email,
  });

  // Step 7 — pin an organization. Issue #209. Credentials are already
  // persisted so `listOrgs` / `createOrg` (both authenticated) work.
  // Any failure here leaves the login valid but unpinned — surfaced as
  // a hint to the user, never as a hard failure.
  const pinned = await pinOrgOnProfile(profileName, opts);

  const orgSuffix = pinned ? ` to "${pinned.name}" (${pinned.id})` : "";
  outro(`Logged in as ${identity.email}${orgSuffix}`);

  if (!pinned) {
    process.stdout.write(
      `No org pinned — pass -H "X-Org-Id: …" on each call, or run \`appstrate org switch\` later.\n`,
    );
  }
}

/**
 * Resolve the org-pin branch of the login flow. Returns the pinned org
 * on success, `null` when the user opted out or no pin could be made
 * (e.g. `--no-org`, zero orgs + user cancelled, non-TTY with no flag).
 *
 * Writes the pinned `orgId` back onto `config.toml` in place. The caller
 * has already persisted the rest of the profile via `setProfile()`.
 */
async function pinOrgOnProfile(profileName: string, opts: LoginOptions): Promise<Org | null> {
  const deps = { ...defaultDeps, ...(opts.deps ?? {}) };

  // `--no-org` short-circuits everything, including the network call.
  if (opts.noOrg) return null;

  // `--create-org <name>` short-circuits the list fetch — the user knows
  // they want a fresh org. Don't second-guess them with a prompt.
  if (opts.createOrg !== undefined) {
    const created = await createOrg(profileName, { name: opts.createOrg });
    await persistOrgId(profileName, created.id);
    return created;
  }

  let orgs: Org[];
  try {
    orgs = await listOrgs(profileName);
  } catch (err) {
    // Don't fail the login if /api/orgs is temporarily down — tokens
    // are already persisted and the user can retry with `org switch`.
    process.stderr.write(
      `Failed to list organizations: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }

  // `--org <id-or-slug>` — explicit non-interactive selection.
  if (opts.org !== undefined) {
    const match = resolveOrgRef(orgs, opts.org);
    await persistOrgId(profileName, match.id);
    return match;
  }

  if (orgs.length === 1) {
    const only = orgs[0]!;
    await persistOrgId(profileName, only.id);
    return only;
  }

  if (orgs.length === 0) {
    const input = await deps.promptCreateOrg();
    if (!input) return null;
    const created = await createOrg(profileName, input);
    await persistOrgId(profileName, created.id);
    return created;
  }

  // ≥2 orgs — delegate the (possibly non-TTY) decision to the picker.
  const chosen = await deps.pickOrg(orgs);
  if (!chosen) return null;
  await persistOrgId(profileName, chosen.id);
  return chosen;
}

/**
 * Rewrite the profile's `orgId` without disturbing the other fields.
 * `setProfile` replaces the whole row, so we re-read first to preserve
 * `userId` / `email` / `instance` that `runLogin` just persisted.
 */
async function persistOrgId(profileName: string, orgId: string): Promise<void> {
  const config = await readConfig();
  const existing = config.profiles[profileName];
  if (!existing) {
    // Should never happen: `runLogin` called `setProfile` before this.
    // Fail loudly — silent fallback would mask a real regression.
    throw new Error(
      `Profile "${profileName}" missing from config when pinning org — internal invariant broken.`,
    );
  }
  await setProfile(profileName, { ...existing, orgId });
}
