// SPDX-License-Identifier: Apache-2.0

/**
 * API version registry — date-based versioning (Stripe pattern).
 *
 * Each version is an ISO date string (YYYY-MM-DD). The org can pin to a version
 * via `organizations.orgSettings.api_version`. Clients can override per-request
 * via the `Appstrate-Version` header.
 *
 * ## What a version currently gates: nothing.
 *
 * `SUPPORTED_VERSIONS` holds exactly one entry, and the resolved version is
 * only validated (`middleware/api-version.ts` rejects unsupported values with
 * a 400), stashed on the request context as `apiVersion`, and echoed back in
 * the `Appstrate-Version` response header. No route, serializer, or DTO reads
 * `c.get("apiVersion")` to branch on behaviour — every caller receives the same
 * responses regardless of what they send. The header is a contract placeholder
 * and a client-side hint, not a behavioural switch.
 *
 * ## What must exist before a second version ships
 *
 * Adding an entry to `SUPPORTED_VERSIONS` is not sufficient: the moment two
 * versions coexist, callers need to be told which one is going away and when,
 * and we need a rule for what a bump may legitimately change. At minimum:
 *
 * 1. **`Deprecation` header** (RFC 9745) on responses served under a version
 *    that is no longer current, so clients can detect drift automatically.
 * 2. **`Sunset` header** (RFC 8594) carrying the date the version stops being
 *    served, plus a `Link rel="deprecation"` to the migration notes.
 * 3. **A written version-bump policy** — which changes require a new version
 *    (removed/renamed wire fields, narrowed types, changed defaults, changed
 *    status codes) versus which ship unversioned (additive fields, new
 *    endpoints, bug fixes) — and how long a version stays supported.
 *
 * None of the three exist today. They are deliberately not built ahead of the
 * second version (YAGNI); this note records the debt so the work is not
 * discovered mid-migration.
 */

export const CURRENT_API_VERSION = "2026-03-21";

/**
 * All versions the server can serve. Oldest first.
 *
 * **Removing an entry is a data migration, not an edit.** `createOrganization`
 * pins every org at creation (`services/organizations.ts`), so essentially every
 * org carries a value from this set. `middleware/api-version.ts` 400s on a pin it
 * cannot serve, and it is mounted on `*`.
 *
 * So dropping a version without repointing the orgs still on it — in the same
 * release — makes every affected org fail on every route, platform-wide. The only
 * client-side workaround is sending an explicit `Appstrate-Version` header, which
 * the SPA does not do, so the product is unusable for them until the data is fixed.
 *
 * Ship the backfill (`UPDATE organizations SET org_settings = ... `) with the removal.
 */
const SUPPORTED_VERSIONS = new Set(["2026-03-21"]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidVersionFormat(v: string): boolean {
  return ISO_DATE_RE.test(v);
}

export function isVersionSupported(v: string): boolean {
  return SUPPORTED_VERSIONS.has(v);
}
