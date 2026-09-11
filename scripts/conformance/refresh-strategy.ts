// SPDX-License-Identifier: Apache-2.0

/**
 * Refresh-strategy declaration check for `oauth2` auths.
 *
 * An OAuth2 connection that mints a short-lived access token and NO refresh
 * token is born dead: it works for the provider's access-token lifetime, then
 * flips to `needs_reconnection`. Whether a provider issues a refresh token is
 * never implicit — most gate it on something the authorize request must ask
 * for, and every provider spells that differently:
 *
 *   - Google      `access_type=offline` (+ `prompt=consent`)   authorize param
 *   - Dropbox     `token_access_type=offline`                  authorize param
 *   - Reddit      `duration=permanent`                         authorize param
 *   - Microsoft   `offline_access`                             scope
 *   - Salesforce  `refresh_token` / `offline_access`           scope
 *
 * The platform already refuses such a connection at connect time
 * (`services/connect/oauth2-strategy.ts` — short-lived token + no refresh
 * token + a server that supports refresh → hard refusal). That guard exists
 * BECAUSE the class already shipped once: `@appstrate/gmail` self-disconnected
 * on Google without `access_type=offline`. But a runtime refusal fires on a
 * real user, mid-consent, after they registered an OAuth app — which is
 * exactly how `@appstrate/dropbox` (missing `token_access_type=offline`)
 * reached a customer.
 *
 * This check moves the same question to authoring time. It cannot know what a
 * given provider requires — that is per-provider documentation, not something
 * derivable from a manifest — so it does not try. It requires the AUTHOR to
 * have answered it, in one of three ways:
 *
 *   1. `authorization_params` is non-empty — the manifest asks for offline
 *      access explicitly (Google / Dropbox / Reddit shape).
 *   2. `default_scopes` carries an offline-ish scope (`offline_access`,
 *      `offline`) — the Microsoft / Salesforce / Xero shape.
 *   3. `_meta["dev.appstrate/oauth"].refresh_token_issuance` states the provider needs
 *      neither: `"default"` (issues a refresh token unconditionally) or
 *      `"not_supported"` (issues no refresh token at all — the connection
 *      re-authorises at expiry, by design).
 *
 * Anything else fails. {@link UNVERIFIED} is the burn-down list of auths that
 * predate the check and whose provider behaviour nobody has confirmed against
 * documentation yet: they downgrade the failure to a warning so the backlog is
 * REPORTED rather than silently grandfathered, and a new integration cannot
 * join it without an explicit, reviewable line in this file.
 *
 * Deterministic, no network, no credentials → runs in the `gate` tier.
 */

import type { SystemPackageEntry } from "@appstrate/core/system-packages";
import type { Finding } from "./types.ts";

const CHECK = "refresh-strategy";

/**
 * Scopes that, by convention, are how a provider is asked for a refresh token.
 * Matched case-insensitively against `default_scopes`, including the URI-style
 * scopes some providers use (`.../auth/offline_access`).
 */
const OFFLINE_SCOPE_PATTERN = /(^|[/.:])offline([_.]access)?$/i;

/** Accepted values of `_meta["dev.appstrate/oauth"].refresh_token_issuance`. */
const REFRESH_DECLARATIONS = new Set(["default", "not_supported"]);

/**
 * Auths that predate this check and whose refresh behaviour has NOT been
 * confirmed against the provider's documentation. Entries are
 * `"<packageId>:<authKey>"`.
 *
 * This list only ever shrinks, and {@link UNVERIFIED_CEILING} — which must
 * equal its size exactly — is what makes that mechanical rather than
 * aspirational. Do NOT add a new integration here: a new manifest's author is
 * the one person who has the provider's docs open, and the ceiling will
 * reject the addition anyway.
 *
 * ## Burning one entry down
 *
 * "Verifying" an entry is a documentation task, not a code task. For
 * `"@appstrate/foo:primary"`:
 *
 *   1. Open that provider's OAuth documentation and answer ONE question:
 *      what does an authorize request have to say for the token endpoint to
 *      return a `refresh_token`? Providers answer it in one of three shapes —
 *      an authorize-time parameter, a scope, or "nothing, we always issue
 *      one" / "nothing, we never issue one".
 *   2. Record the answer in `scripts/system-packages/integration-foo-<v>/manifest.json`,
 *      under `auths.primary`:
 *      - authorize parameter → add it to `authorization_params`, AND add the
 *        `name: value` pair to {@link OFFLINE_AUTHORIZE_PARAMS} below if this
 *        check does not recognise it yet (an unlisted parameter proves
 *        nothing — see that table's own comment);
 *      - scope → add it to `default_scopes` (and to the auth's
 *        `scope_catalog`, which `build:system-packages:check` cross-checks);
 *      - neither → set
 *        `_meta["dev.appstrate/oauth"].refresh_token_issuance` to `"default"`
 *        or `"not_supported"`.
 *   3. Bump the package `version`, rename its source directory to match, and
 *      run `bun run scripts/build-system-packages.ts` — an already-published
 *      version is immutable, so without the bump the fix never reaches
 *      production (#928).
 *   4. Delete the entry from this list AND decrement {@link UNVERIFIED_CEILING}
 *      by one. Both, in the same commit: the ceiling is an equality, so
 *      either edit alone fails the gate.
 *
 * Step 4 is the only step that touches this file, and it is the only step
 * that can be done without reading the provider's docs — which is why it is
 * gated on step 2 having actually happened: drop an entry whose manifest
 * still declares nothing and the auth stops being a warning and becomes a
 * hard `fail`, immediately, in the same run.
 */
export const UNVERIFIED = new Set<string>([
  "@appstrate/airtable:primary",
  "@appstrate/asana:primary",
  "@appstrate/basecamp:primary",
  "@appstrate/calendly:primary",
  "@appstrate/canva:primary",
  "@appstrate/canva-mcp:oauth",
  "@appstrate/clickup:primary",
  "@appstrate/clickup-mcp:oauth",
  "@appstrate/convertkit:primary",
  "@appstrate/discord:primary",
  "@appstrate/github:primary",
  "@appstrate/github-git:oauth",
  "@appstrate/github-mcp:oauth",
  "@appstrate/hubspot:primary",
  "@appstrate/intercom:primary",
  "@appstrate/linear:primary",
  "@appstrate/linkedin:primary",
  "@appstrate/mailchimp:primary",
  "@appstrate/monday:primary",
  "@appstrate/notion:primary",
  "@appstrate/notion-mcp:oauth",
  "@appstrate/paypal:primary",
  "@appstrate/pinterest:primary",
  "@appstrate/pipedrive:primary",
  "@appstrate/quickbooks-online:primary",
  "@appstrate/slack:primary",
  "@appstrate/wrike:primary",
  "@appstrate/zoho-crm:primary",
  "@appstrate/zoom:primary",
]);

interface OAuthAuth {
  type?: unknown;
  default_scopes?: unknown;
  authorization_params?: unknown;
  _meta?: unknown;
}

/** Read the manifest's `oauth2` auths, tolerating a missing/foreign shape. */
function oauthAuths(manifest: Record<string, unknown>): Array<[string, OAuthAuth]> {
  const auths = manifest.auths;
  if (!auths || typeof auths !== "object") return [];
  return Object.entries(auths as Record<string, unknown>).filter(
    (e): e is [string, OAuthAuth] =>
      !!e[1] && typeof e[1] === "object" && (e[1] as OAuthAuth).type === "oauth2",
  );
}

/**
 * Authorize-time parameters that actually ask a provider for offline access,
 * as `name` → accepted values. Every entry is transcribed from that provider's
 * documentation; a parameter absent from this table proves nothing about
 * refresh tokens.
 *
 * Named explicitly BECAUSE the first version of this check accepted any
 * non-empty `authorization_params` as evidence — so a manifest carrying only
 * `prompt: "select_account"` passed while requesting no offline access at all.
 * That is the same "looks like it declares something" failure the check exists
 * to catch.
 */
const OFFLINE_AUTHORIZE_PARAMS: Record<string, ReadonlySet<string>> = {
  // Google (gmail, drive, calendar, sheets, forms, contacts, youtube).
  access_type: new Set(["offline"]),
  // Dropbox.
  token_access_type: new Set(["offline"]),
  // Reddit.
  duration: new Set(["permanent"]),
};

/**
 * Whether the auth asks for offline access via a RECOGNISED authorize-time
 * parameter set to a value that actually requests it.
 */
function requestsOfflineViaAuthorizeParam(auth: OAuthAuth): boolean {
  const params = auth.authorization_params;
  if (!params || typeof params !== "object") return false;
  return Object.entries(params as Record<string, unknown>).some(([name, value]) => {
    const accepted = OFFLINE_AUTHORIZE_PARAMS[name];
    return accepted !== undefined && typeof value === "string" && accepted.has(value);
  });
}

/** Whether the auth asks for offline access via a scope. */
function hasOfflineScope(auth: OAuthAuth): boolean {
  const scopes = auth.default_scopes;
  if (!Array.isArray(scopes)) return false;
  return scopes.some((s) => typeof s === "string" && OFFLINE_SCOPE_PATTERN.test(s));
}

/**
 * The manifest's explicit `refresh` declaration, or `undefined` when absent.
 * An unrecognised value is treated as absent — and reported as such, so a typo
 * (`"none"`, `"n/a"`) cannot silently satisfy the check.
 */
function refreshDeclaration(auth: OAuthAuth): string | undefined {
  const meta = auth._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const oauthMeta = (meta as Record<string, unknown>)["dev.appstrate/oauth"];
  if (!oauthMeta || typeof oauthMeta !== "object") return undefined;
  const value = (oauthMeta as Record<string, unknown>).refresh_token_issuance;
  return typeof value === "string" && REFRESH_DECLARATIONS.has(value) ? value : undefined;
}

/** Evaluate one auth. */
function evaluateAuth(packageId: string, authKey: string, auth: OAuthAuth): Finding {
  if (requestsOfflineViaAuthorizeParam(auth)) {
    return {
      packageId,
      check: CHECK,
      severity: "info",
      message: `${authKey}: refresh requested via a recognised authorization parameter`,
    };
  }
  if (hasOfflineScope(auth)) {
    return {
      packageId,
      check: CHECK,
      severity: "info",
      message: `${authKey}: refresh requested via an offline scope`,
    };
  }
  const declared = refreshDeclaration(auth);
  if (declared) {
    return {
      packageId,
      check: CHECK,
      severity: "info",
      message: `${authKey}: refresh declared "${declared}"`,
    };
  }
  const message =
    `${authKey}: no refresh strategy — the auth requests no offline access ` +
    `(authorization_params / offline scope) and declares no ` +
    `_meta["dev.appstrate/oauth"].refresh_token_issuance ("default" | "not_supported"). ` +
    `A provider that mints short-lived tokens will return none, and the ` +
    `connection is refused at connect time.`;
  return UNVERIFIED.has(`${packageId}:${authKey}`)
    ? { packageId, check: CHECK, severity: "warn", message: `${message} (unverified backlog)` }
    : { packageId, check: CHECK, severity: "fail", message };
}

/** Every `"<packageId>:<authKey>"` an oauth2 auth in `entries` resolves to. */
function declaredAuthKeys(entries: SystemPackageEntry[]): Set<string> {
  const keys = new Set<string>();
  for (const entry of entries) {
    for (const [key] of oauthAuths(entry.manifest)) keys.add(`${entry.packageId}:${key}`);
  }
  return keys;
}

/**
 * The size {@link UNVERIFIED} is allowed to have. Not an upper bound — an
 * EQUALITY, and it may only ever be decremented.
 *
 * Without a ceiling the waiver list is a TODO in a nicer shell: it grows
 * silently, and 29 permanent warnings train everyone to stop reading the
 * report — which is exactly what happened between this constant landing
 * (2026-08-19) and the audit that found it still at 29 with zero burn-down.
 * The repo already ratchets `verify:type-coverage --at-least 98` for the same
 * reason; this is that pattern applied to provider knowledge.
 *
 * It is an equality and not a `<=` because the two failure modes are opposite
 * and a `<=` only catches one of them:
 *
 *   - grown (`size > ceiling`) — a new integration joined the backlog instead
 *     of declaring its refresh strategy. A `<=` catches this.
 *   - shrunk (`size < ceiling`) — someone did the real work, verified a
 *     provider and removed its entry, and left the ceiling where it was. A
 *     `<=` waves this through, and the slack it leaves is a free seat: the
 *     next addition then passes silently. That is how a ratchet stops
 *     ratcheting, so it is a failure here too, with a message that says
 *     "you're done, write the smaller number down".
 *
 * The equality is also what makes the remaining hole small enough to police
 * by review. Raising this constant is still just an edit — no gate can stop
 * a determined `= 30` — but it is now the ONLY edit that can turn a grown
 * list green, it is one line, it is named, and it contradicts the sentence
 * directly above it. A `+1` buried in a 29-line alphabetical list is not.
 */
export const UNVERIFIED_CEILING = 29;

/**
 * Fail unless the backlog is exactly its ceiling — in either direction. See
 * {@link UNVERIFIED_CEILING} for why both directions are failures.
 *
 * `size` and `ceiling` default to the checked-in pair, which is the only way
 * production calls it. They are parameters so the two violating states can be
 * exercised for real in tests: both live values are module constants, and the
 * alternative — asserting against a re-implementation of this branch — would
 * test nothing.
 */
export function checkBacklogCeiling(
  size: number = UNVERIFIED.size,
  ceiling: number = UNVERIFIED_CEILING,
): Finding[] {
  if (size === ceiling) return [];
  return [
    {
      packageId: "(conformance)",
      check: CHECK,
      severity: "fail",
      message:
        size > ceiling
          ? `UNVERIFIED holds ${size} entries, above its ceiling of ${ceiling}. ` +
            `A new integration must declare its refresh strategy, not join the ` +
            `backlog — the list only ever shrinks, and raising UNVERIFIED_CEILING ` +
            `to make this pass is the wrong fix. Burn-down procedure: see the ` +
            `comment on UNVERIFIED in scripts/conformance/refresh-strategy.ts.`
          : `UNVERIFIED holds ${size} entries but its ceiling is still ${ceiling}. ` +
            `An entry was verified away without lowering the ceiling, which leaves ` +
            `${ceiling - size} free seat(s) a future waiver could take silently. ` +
            `Set UNVERIFIED_CEILING = ${size} in ` +
            `scripts/conformance/refresh-strategy.ts.`,
    },
  ];
}

/**
 * Fail on {@link UNVERIFIED} entries that no longer match any oauth2 auth.
 *
 * A grandfathering list that keeps entries for auths that were renamed,
 * retired, or fixed stops being a backlog and becomes noise — worse, a stale
 * entry silently pre-grants the waiver to a future package that happens to
 * reuse the id. Callers must skip this when the run is filtered to a subset of
 * packages, where every other entry looks stale by construction.
 */
export function checkUnverifiedBacklog(entries: SystemPackageEntry[]): Finding[] {
  const declared = declaredAuthKeys(entries);
  return [...UNVERIFIED]
    .filter((key) => !declared.has(key))
    .map((key) => ({
      packageId: key.split(":")[0]!,
      check: CHECK,
      severity: "fail" as const,
      message:
        `stale UNVERIFIED entry "${key}" — no oauth2 auth resolves to it. ` +
        `Remove it from scripts/conformance/refresh-strategy.ts.`,
    }));
}

/** Check every `oauth2` auth a package declares. */
export function checkRefreshStrategy(entry: SystemPackageEntry): Finding[] {
  return oauthAuths(entry.manifest).map(([key, auth]) => evaluateAuth(entry.packageId, key, auth));
}
