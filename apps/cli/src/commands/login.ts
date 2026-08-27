// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate login` — interactive device-flow sign-in.
 *
 * Flow:
 *   1. Resolve profile name (flag → env → default).
 *   2. Ask for instance URL if not passed via `--instance`.
 *   3. POST /api/auth/device/code → receive user_code + verification URL.
 *   4. Print the code in the terminal + open the browser.
 *   5. Poll /api/auth/cli/token until approval.
 *   6. Store the JWT access + rotating refresh pair in the keyring
 *      (issue #165); decode `sub` + `email` from the JWT payload
 *      (via `lib/jwt-identity.ts`) to capture userId + email;
 *      persist the profile in config.toml.
 *   7. Pin an organization on the profile so subsequent `X-Org-Id`-
 *      requiring routes (`/api/me`, `/api/agents`, …) work out of the
 *      box. Issue #209. Auto-pin on one org, interactive picker on
 *      many, offer inline creation on zero. Non-interactive escapes:
 *      `--org <id-or-slug>`, `--create-org <name>`, `--no-org`.
 *   8. Cascade: pin a space on the profile so subsequent
 *      `X-Space-Id`-requiring routes (`/api/agents`, `/api/runs`, …)
 *      work out of the box. Issue #217. Auto-pins the default space
 *      (the server provisions one per org). Non-interactive escapes:
 *      `--space <id>`, `--create-space <name>`, `--no-space`.
 */

import open from "open";
import {
  intro,
  outro,
  askText,
  select,
  withSpinner,
  formatUserCode,
  exitWithError,
} from "../lib/ui.ts";
import { DEFAULT_IO, type CommandIO } from "../lib/io.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import {
  readConfig,
  resolveProfileName,
  setProfile,
  updateProfile,
  getProfile,
} from "../lib/config.ts";
import { saveTokens } from "../lib/keyring.ts";
import { startDeviceFlow, pollDeviceFlow } from "../lib/device-flow.ts";
import { normalizeInstance } from "../lib/instance-url.ts";
import { CLI_CLIENT_ID, CLI_SCOPE } from "../lib/cli-client.ts";
import { decodeAccessTokenIdentity } from "../lib/jwt-identity.ts";
import { listOrgs, createOrg, resolveOrgRef, type Org } from "../lib/orgs.ts";
import {
  listSpaces,
  createSpace,
  resolveSpaceRef,
  findDefaultSpace,
  type Space,
} from "../lib/spaces.ts";

interface LoginOptions {
  profile?: string;
  instance?: string;
  /** `--org <id-or-slug>` — non-interactive pin, fails if no match. */
  org?: string;
  /** `--create-org <name>` — non-interactive inline creation + pin. */
  createOrg?: string;
  /** `--no-org` — explicitly skip the whole pin step. */
  noOrg?: boolean;
  /** `--space <id>` — non-interactive space pin, fails if no match. */
  space?: string;
  /** `--create-space <name>` — non-interactive inline creation + pin. */
  createSpace?: string;
  /** `--no-space` — explicitly skip the space-pinning step. */
  noSpace?: boolean;
  /**
   * `--device-name <name>` — human-friendly label rendered in the
   * dashboard's authorized-devices list. Defaults to `os.hostname()`
   * when unset.
   */
  deviceName?: string;
  deps?: LoginDeps;
}

/**
 * Dependency-injected prompt helpers so the login command is testable
 * without mock.module (banned per CLAUDE.md). Production paths bind to
 * the real `@clack/prompts` helpers in `lib/ui.ts`. Return `null` from
 * either hook to signal "user opted out / cannot prompt" — the caller
 * leaves `orgId` unset and prints a follow-up hint.
 */
interface LoginDeps {
  /** Interactive picker when the user belongs to ≥2 orgs. */
  pickOrg?: (orgs: Org[]) => Promise<Org | null>;
  /** Prompt the user for a new org name + optional slug. */
  promptCreateOrg?: () => Promise<{ name: string; slug?: string } | null>;
}

// `APPSTRATE_CLI_NO_OPEN=1` disables the browser launch — the test
// preload sets it so `bun test` never pops real tabs.
async function defaultOpenUrl(url: string): Promise<void> {
  if (process.env.APPSTRATE_CLI_NO_OPEN === "1") return;
  await open(url);
}

/**
 * Built as a function of `io` rather than a module constant so the non-TTY
 * fallbacks write to the caller's sink. The hooks themselves keep their
 * `io`-free signatures — a test injecting `pickOrg` is choosing an org, not
 * choosing where bytes go.
 */
function makeDefaultDeps(io: CommandIO): Required<LoginDeps> {
  return {
    pickOrg: async (orgs: Org[]): Promise<Org | null> => {
      if (!process.stdin.isTTY) {
        io.stdout.write(
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
        io.stdout.write(
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
}

/**
 * `io` is a trailing parameter rather than another `LoginDeps` member: it is
 * threaded through every helper below, including the ones that never prompt
 * (`pinSpaceOnProfile`), whereas `LoginDeps` is documented — and injected by
 * tests — as the interactive-prompt seam alone. The default keeps `cli.ts`'s
 * single-argument call site working untouched.
 */
export async function loginCommand(opts: LoginOptions, io: CommandIO = DEFAULT_IO): Promise<void> {
  const config = await readConfig();
  const profileName = resolveProfileName(opts.profile, config);

  intro(`Appstrate login — profile "${profileName}"`, io);

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
    // Pass `io` explicitly: the default would exit the *process*, which in a
    // test run means killing the runner instead of failing one test.
    exitWithError(err, io);
  }

  try {
    await runLogin(profileName, normalizedInstance, opts, io);
  } catch (err) {
    exitWithError(err, io);
  }
}

async function runLogin(
  profileName: string,
  instance: string,
  opts: LoginOptions,
  io: CommandIO,
): Promise<void> {
  // Step 1 — device code.
  const code = await withSpinner(
    "Requesting device code",
    () => startDeviceFlow(instance, CLI_CLIENT_ID, CLI_SCOPE),
    (issued) => `Code received — expires in ${Math.round(issued.expiresIn / 60)}m`,
    { io },
  );

  const display = formatUserCode(code.userCode);

  // Step 2 — show the user what to do. Print outside the spinner so the
  // code remains visible even after the spinner rewinds the cursor.
  io.stdout.write(`\n  Visit: ${code.verificationUri}\n`);
  io.stdout.write(`  Code:  ${display}\n\n`);

  // Step 3 — open the browser on the complete URI (pre-fills user_code).
  // If `open` fails (headless SSH / no display), the printed URL + code
  // above keep the flow usable. Swallow the error silently.
  defaultOpenUrl(code.verificationUriComplete).catch(() => {});

  // Step 4 — poll until approval or terminal error.
  const token = await withSpinner(
    "Waiting for approval in your browser",
    () =>
      pollDeviceFlow(instance, code.deviceCode, CLI_CLIENT_ID, {
        interval: code.interval,
        expiresIn: code.expiresIn,
        deviceName: opts.deviceName,
      }),
    "Approved",
    { io },
  );

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

  // Preserve the previous `orgId` / `spaceId` when re-logging-in as the
  // SAME user. Without this, a re-login whose step-7 / step-8 list call
  // happens to flake (network, server blip) would silently drop the pins
  // the user had carefully set — surprising regression. Only carry them
  // over when `userId` matches: re-logging-in as a different user on the
  // same profile must NOT inherit the previous account's pins.
  const existingProfile = (await readConfig()).profiles[profileName];
  const sameUser = existingProfile?.userId === identity.userId;
  const preservedOrgId = sameUser && existingProfile?.orgId ? existingProfile.orgId : undefined;
  const preservedSpaceId =
    sameUser && existingProfile?.spaceId ? existingProfile.spaceId : undefined;

  await setProfile(profileName, {
    instance,
    userId: identity.userId,
    email: identity.email,
    ...(preservedOrgId ? { orgId: preservedOrgId } : {}),
    ...(preservedSpaceId ? { spaceId: preservedSpaceId } : {}),
  });

  // Step 7 — pin an organization. Issue #209. Credentials are already
  // persisted so `listOrgs` / `createOrg` (both authenticated) work.
  // Any failure here leaves the login valid but unpinned — surfaced as
  // a hint to the user, never as a hard failure.
  const pinned = await pinOrgOnProfile(profileName, opts, io);

  // Step 8 — cascade into space pinning. Issue #217. Requires an
  // `orgId` in context (listSpaces is org-scoped), so we gate on
  // `pinned` rather than re-fetching from the keyring.
  const pinnedSpace = await pinSpaceOnProfile(profileName, opts, pinned, io);

  const orgSuffix = pinned ? ` to "${pinned.name}" (${pinned.id})` : "";
  const spaceSuffix = pinnedSpace ? ` / space "${pinnedSpace.name}" (${pinnedSpace.id})` : "";
  outro(`Logged in as ${identity.email}${orgSuffix}${spaceSuffix}`, io);

  if (!pinned) {
    io.stdout.write(
      `No org pinned — pass -H "X-Org-Id: …" on each call, or run \`appstrate org switch\` later.\n`,
    );
  } else if (!pinnedSpace && !opts.noSpace) {
    io.stdout.write(
      `No space pinned — pass -H "X-Space-Id: …" on each call, or run \`appstrate space switch\` later.\n`,
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
/**
 * Pin `orgId` on the profile, clearing any previously pinned `spaceId`
 * when the org actually changes. A `spaceId` is only meaningful inside
 * its owning org, so a re-login that switches orgs (`--org <other>`, picker
 * choosing a different org, `--create-org`) must not leave the OLD org's space
 * pinned — the space-pin cascade (`pinSpaceOnProfile`) re-populates it immediately
 * afterward for the new org. Same-org re-logins keep the preserved space pin.
 */
async function pinOrgResettingStaleSpace(profileName: string, orgId: string): Promise<void> {
  const existing = await getProfile(profileName);
  const orgChanged = existing?.orgId !== undefined && existing.orgId !== orgId;
  await updateProfile(profileName, {
    orgId,
    ...(orgChanged ? { spaceId: undefined } : {}),
  });
}

async function pinOrgOnProfile(
  profileName: string,
  opts: LoginOptions,
  io: CommandIO,
): Promise<Org | null> {
  const deps = { ...makeDefaultDeps(io), ...(opts.deps ?? {}) };

  // `--no-org` short-circuits everything, including the network call.
  if (opts.noOrg) return null;

  // `--create-org <name>` short-circuits the list fetch — the user knows
  // they want a fresh org. Don't second-guess them with a prompt.
  if (opts.createOrg !== undefined) {
    const created = await createOrg(profileName, { name: opts.createOrg });
    await pinOrgResettingStaleSpace(profileName, created.id);
    return created;
  }

  let orgs: Org[];
  try {
    orgs = await listOrgs(profileName);
  } catch (err) {
    // Don't fail the login if /api/orgs is temporarily down — tokens
    // are already persisted and the user can retry with `org switch`.
    io.stderr.write(`Failed to list organizations: ${getErrorMessage(err)}\n`);
    return null;
  }

  // `--org <id-or-slug>` — explicit non-interactive selection.
  if (opts.org !== undefined) {
    const match = resolveOrgRef(orgs, opts.org);
    await pinOrgResettingStaleSpace(profileName, match.id);
    return match;
  }

  if (orgs.length === 1) {
    const only = orgs[0]!;
    await pinOrgResettingStaleSpace(profileName, only.id);
    return only;
  }

  if (orgs.length === 0) {
    const input = await deps.promptCreateOrg();
    if (!input) return null;
    const created = await createOrg(profileName, input);
    await pinOrgResettingStaleSpace(profileName, created.id);
    return created;
  }

  // ≥2 orgs — delegate the (possibly non-TTY) decision to the picker.
  const chosen = await deps.pickOrg(orgs);
  if (!chosen) return null;
  await pinOrgResettingStaleSpace(profileName, chosen.id);
  return chosen;
}

/**
 * Resolve the space-pin branch of the login cascade. Issue #217.
 *
 * Gated on a successful org pin: `GET /api/spaces` needs an
 * `X-Org-Id` header, so when no org is pinned (user passed `--no-org`,
 * or the cascade failed) we return null without a network call.
 *
 * Unlike `pinOrgOnProfile` this does NOT expose an interactive picker at
 * login time — the server provisions exactly one default space per
 * org, so the non-flag path is fully deterministic. Users with ≥2 spaces
 * and no clear default get a stderr hint and pin manually via
 * `appstrate space switch` afterwards.
 */
async function pinSpaceOnProfile(
  profileName: string,
  opts: LoginOptions,
  orgPinned: Org | null,
  io: CommandIO,
): Promise<Space | null> {
  if (opts.noSpace) return null;
  if (!orgPinned) return null;

  if (opts.createSpace !== undefined) {
    const created = await createSpace(profileName, opts.createSpace);
    await updateProfile(profileName, { spaceId: created.id });
    return created;
  }

  let spaces: Space[];
  try {
    spaces = await listSpaces(profileName);
  } catch (err) {
    io.stderr.write(`Failed to list spaces: ${getErrorMessage(err)}\n`);
    return null;
  }

  // `--space <id>` — explicit non-interactive selection.
  if (opts.space !== undefined) {
    const match = resolveSpaceRef(spaces, opts.space);
    await updateProfile(profileName, { spaceId: match.id });
    return match;
  }

  if (spaces.length === 0) {
    // Should be impossible in practice — every org has a server-provisioned
    // default space. Surface defensively in case of partial state.
    io.stderr.write(
      "No spaces found on the pinned organization — run `appstrate space create <name>` to create one.\n",
    );
    return null;
  }

  if (spaces.length === 1) {
    const only = spaces[0]!;
    await updateProfile(profileName, { spaceId: only.id });
    return only;
  }

  // ≥2 spaces — pin the server-provisioned default. If none is marked,
  // surface a hint; pinning silently to spaces[0] would be too guessy.
  const def = findDefaultSpace(spaces);
  if (def) {
    await updateProfile(profileName, { spaceId: def.id });
    return def;
  }
  io.stderr.write(
    "Multiple spaces but none marked default — run `appstrate space switch` to pin one.\n",
  );
  return null;
}
