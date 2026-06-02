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
 * A package is covered only when it has BOTH an entry here AND a credential in
 * `CONFORMANCE_TOKENS`. Uncovered packages are silently skipped; coverage
 * grows by adding entries + provisioning a sandbox token. Pick endpoints that
 * are read-only and side-effect free (a "whoami"), so a monitor run never
 * mutates the sandbox account.
 */

export interface AuthProbe {
  /** Read-only endpoint to GET with the package's credential injected. */
  url: string;
  /** HTTP statuses that count as "credential accepted / provider alive". */
  expectStatus: number[];
  /** Which manifest auth to deliver. Defaults to the manifest's first auth. */
  authKey?: string;
}

/**
 * package id → probe. Seeded with a few well-known whoami endpoints; extend as
 * sandbox credentials are provisioned. Note: some providers (e.g. Slack)
 * return HTTP 200 with an `ok:false` body on a bad token — a status-only probe
 * still confirms reachability + that the auth header was structurally
 * accepted, which is the point at this tier.
 */
export const AUTH_PROBES: Record<string, AuthProbe> = {
  "@appstrate/github": { url: "https://api.github.com/user", expectStatus: [200] },
  "@appstrate/slack": { url: "https://slack.com/api/auth.test", expectStatus: [200] },
  "@appstrate/stripe": { url: "https://api.stripe.com/v1/account", expectStatus: [200] },
  // calendar.readonly scope — read-only list of the user's calendars.
  "@appstrate/google-calendar": {
    url: "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    expectStatus: [200],
  },
};
