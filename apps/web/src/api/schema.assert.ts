// SPDX-License-Identifier: Apache-2.0

/**
 * Compile-time guard for the generated OpenAPI types (`schema.d.ts`).
 *
 * `tsconfig.base.json` sets `skipLibCheck: true`, so the generated `.d.ts` is
 * NOT type-checked on its own. The `verify:api-types --check` gate guards
 * against a *stale* schema (byte-equality vs a fresh regen), but nothing else
 * proves the generated types are still *usable* the way the client/hooks rely
 * on them. This file is a regular `.ts` module (checked even under
 * skipLibCheck) that pins the load-bearing shapes the typed client is built
 * on: if a spec change silently reshapes one of them, this file fails to
 * compile here — a clear, local signal in addition to the drift gate.
 *
 * Keep these assertions minimal and structural; they are contracts, not tests.
 */
import type { paths, components, operations } from "./schema";

// The three generated entrypoints must exist and be non-empty objects.
type _Paths = keyof paths;
type _Components = keyof components["schemas"];
type _Operations = keyof operations;

// Assert a key is present in a union (fails to compile if the path/schema is
// renamed or dropped from the spec).
type Assert<T extends true> = T;
type Has<K extends PropertyKey, U extends PropertyKey> = K extends U ? true : false;

// Load-bearing endpoints the SPA cannot function without.
type _HasOrgs = Assert<Has<"/api/orgs", _Paths>>;
type _HasRuns = Assert<Has<"/api/runs/{id}", _Paths>>;
type _HasRunLogs = Assert<Has<"/api/runs/{id}/logs", _Paths>>;
type _HasApplications = Assert<Has<"/api/applications", _Paths>>;
type _HasUploads = Assert<Has<"/api/uploads", _Paths>>;

// Load-bearing component schemas consumed by hooks/components by name.
type _HasProblemDetail = Assert<Has<"ProblemDetail", _Components>>;
type _HasRunLog = Assert<Has<"RunLog", _Components>>;

// The RFC 9457 error body must keep the fields the client middleware reads
// (`code`/`detail`/`requestId`) — these drive `ApiError`.
type _ProblemDetail = components["schemas"]["ProblemDetail"];
type _ProblemDetailContract = Assert<
  Has<"code", keyof _ProblemDetail> extends true
    ? Has<"detail", keyof _ProblemDetail> extends true
      ? Has<"requestId", keyof _ProblemDetail>
      : false
    : false
>;

// Suppress "declared but never used" — the assertions live in their declarations.
export type _SchemaAssertions = [
  _Paths,
  _Components,
  _Operations,
  _HasOrgs,
  _HasRuns,
  _HasRunLogs,
  _HasApplications,
  _HasUploads,
  _HasProblemDetail,
  _HasRunLog,
  _ProblemDetailContract,
];
