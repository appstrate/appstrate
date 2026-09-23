// SPDX-License-Identifier: Apache-2.0

/**
 * Auth-liveness probe fixtures — TEST-SIDE, opt-in.
 *
 * Credential-only integrations (`source.kind: "none"`) expose no MCP tool
 * list, so there is nothing to diff. The "test for real" we CAN do is: take a
 * stored credential, hit a known read-only endpoint, and assert the provider
 * accepts the token. That endpoint is not in the manifest (`authorized_uris`
 * is a glob, not a testable URL), so it lives here.
 *
 Every entry is used twice:
 *
 *   - `auth-reject` (tier `mcp`, no secret): the endpoint is sent a
 *     deliberately invalid credential, rendered through the manifest's own
 *     `delivery.http`, and must refuse it. Catches a retired host or API
 *     version on every probed package, credential or not.
 *   - `auth-live` (tier `all`): the same request with a real credential from
 *     `CONFORMANCE_TOKENS` must be accepted. Skipped with a WARN when the
 *     credential is absent.
 *
 * Coverage grows by adding an entry here. Pick endpoints that are read-only
 * and side-effect free (a "whoami"), so a monitor run never mutates the
 * sandbox account, and check the invalid-credential status by hand first: an
 * entry whose endpoint answers 404 to a bad key is not a probe.
 */

interface AuthProbe {
  /** Read-only endpoint to GET with the package's credential injected. */
  url: string;
  /** HTTP statuses that count as "credential accepted / provider alive". */
  expectStatus: number[];
  /** Which manifest auth to deliver. Defaults to the manifest's first auth. */
  authKey?: string;
  /**
   * Whether the endpoint refuses an invalid credential with 401/403, which is
   * what the credential-free `auth-reject` check asserts. `false` for a
   * provider that answers every request 200 and reports the failure in the
   * body (Slack: `{"ok":false,"error":"invalid_auth"}`) — a status-only check
   * cannot tell that apart from success. Defaults to `true`.
   */
  rejectsInvalid?: boolean;
  /**
   * The provider answers an invalid credential byte-for-byte like a missing
   * one (Fathom: an empty 401 either way), so `auth-reject` cannot confirm the
   * manifest's delivery header was read and reports it as unconfirmable
   * instead of failing. Set only after checking both responses by hand.
   */
  sameResponseWithoutCredential?: boolean;
}

/** package id → probe. Each invalid-credential status was checked by hand. */
export const AUTH_PROBES: Record<string, AuthProbe> = {
  "@appstrate/github": { url: "https://api.github.com/user", expectStatus: [200] },
  "@appstrate/slack": {
    url: "https://slack.com/api/auth.test",
    expectStatus: [200],
    rejectsInvalid: false,
  },
  "@appstrate/stripe": { url: "https://api.stripe.com/v1/account", expectStatus: [200] },
  // calendar.readonly scope — read-only list of the user's calendars.
  "@appstrate/google-calendar": {
    url: "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    expectStatus: [200],
  },
  "@appstrate/brevo": { url: "https://api.brevo.com/v3/account", expectStatus: [200] },
  "@appstrate/fathom": {
    url: "https://api.fathom.ai/external/v1/meetings",
    expectStatus: [200],
    sameResponseWithoutCredential: true,
  },
  "@appstrate/firecrawl": {
    url: "https://api.firecrawl.dev/v1/team/credit-usage",
    expectStatus: [200],
  },
  "@appstrate/shortcut": { url: "https://api.app.shortcut.com/api/v3/member", expectStatus: [200] },
  // Basic auth over `account_sid:auth_token` — two credential fields, so
  // `auth-live` cannot take it from a single-string `CONFORMANCE_TOKENS` entry.
  "@appstrate/twilio": {
    url: "https://api.twilio.com/2010-04-01/Accounts.json",
    expectStatus: [200],
  },
};
