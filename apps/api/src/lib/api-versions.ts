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

import { ApiError } from "./errors.ts";

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
 *
 * ## The same hazard applies to values ALREADY stored
 *
 * This is not only a forward constraint. Any org whose stored pin is not a
 * member of this set fails every org-scoped route from the moment the read-side
 * check ships — and a future removal is not the only way to get there. The
 * write path accepted `api_version` as a bare `z.string()` until the guard in
 * `routes/organizations.ts`, and the field is declared writable in the OpenAPI
 * spec, so an admin or a third-party integrator could have persisted an
 * arbitrary string by hand at any point before that guard.
 *
 * Neither source is detectable from the code alone, so `lib/boot.ts` reads the
 * stored pins at startup and logs an `error` line naming every org holding an
 * unserveable one (`warnOnUnserveableApiVersionPins`). That check is the
 * standing signal for both — keep it when adding or dropping a version here.
 */
const SUPPORTED_VERSIONS = new Set([CURRENT_API_VERSION]);

/**
 * Every version this build can serve, as a plain array.
 *
 * Exists for the boot-time diagnostic in `lib/boot.ts`, which has to *enumerate*
 * the set — to hand it to SQL and to name it in the log line — rather than merely
 * test membership. Returns a copy so no caller can mutate the registry.
 */
export function listSupportedVersions(): string[] {
  return [...SUPPORTED_VERSIONS];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidVersionFormat(v: string): boolean {
  return ISO_DATE_RE.test(v);
}

export function isVersionSupported(v: string): boolean {
  return SUPPORTED_VERSIONS.has(v);
}

/**
 * 400 `unsupported_api_version` — the rejection every {@link isVersionSupported}
 * `false` branch raises.
 *
 * Three call sites reach it (the `Appstrate-Version` header, the org pin
 * resolved by `middleware/api-version.ts`, and the org-settings write in
 * `routes/organizations.ts`) and only the wording and the offending `param`
 * differ; status, code and title are the same rejection in all three. Keeping
 * them here means a client branching on `code` cannot be broken by one call
 * site drifting. Pass the complete sentence as `detail` — the factory adds no
 * suffix.
 *
 * `param` is OPTIONAL because one of the three has no request parameter to
 * name. `packages/core/src/api-errors.ts` files `param` as mirroring
 * Stripe's convention — it identifies the *request* parameter at fault so a
 * client can attach the message to the input that produced it. The header and
 * the settings-write callers have one (`Appstrate-Version`, `api_version`); the
 * org pin does not — that value is server-stored state, and the request that
 * trips it (`GET /api/runs`, say) need not carry any parameter at all. Naming
 * `settings.api_version` there would point a consumer at a request field that
 * does not exist, so that site omits `param` entirely and leaves the offending
 * value to `detail`.
 *
 * Mirrors the `conflict()` / `gone()` idiom in `lib/errors.ts`: a named factory
 * per problem type, `code` fixed by construction.
 */
export function unsupportedApiVersion(detail: string, param?: string): ApiError {
  return new ApiError({
    status: 400,
    code: "unsupported_api_version",
    title: "Unsupported API Version",
    detail,
    param,
  });
}
