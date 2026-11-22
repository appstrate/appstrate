// SPDX-License-Identifier: Apache-2.0

/**
 * Centralized React Query keys for the legacy-pinned cache families: produced by a fetch hook but
 * PATCHED / INVALIDATED elsewhere (SSE in `use-global-run-sync`, mutations, org/space-switch
 * resets). Building every key here makes producer/patcher drift a compile error, not a runtime
 * no-op. openapi-react-query hooks keep their own `[method, path, init]` keys; `invalidatePaths`
 * invalidates those.
 */

import type { InvalidateQueryFilters, QueryClient } from "@tanstack/react-query";
import type { paths } from "../api/schema";
import type { SpaceKind } from "./space-filter";

type Id = string | null | undefined;

/** What a list across spaces keys where a space-scoped list keys its space. */
export const ACROSS_SPACES = "across-spaces";

/**
 * A list across spaces (runs, schedules, agents, a package index): it keys its org, never the
 * current space, and holds the marker where its family keys the space (after the org; after the
 * route segment and the org for the package families). Read at that position only: a later
 * segment (a run search) may hold any text.
 */
export function spansSpaces(queryKey: readonly unknown[]): boolean {
  const spaceAt = queryKey[0] === packageKeys.all[0] ? 3 : 2;
  return queryKey[spaceAt] === ACROSS_SPACES;
}

/** A spec path that has a GET operation: the only paths a query key can name. */
export type GetPath = {
  [P in keyof paths]: paths[P] extends { get: object } ? P : never;
}[keyof paths];

/** Invalidates typed-client queries by spec path (the prefix of every `[method, path, init]` key); `refetchType` `"none"` only marks stale, `"all"` also refetches inactive entries. */
export function invalidatePaths(
  qc: QueryClient,
  paths: readonly GetPath[],
  refetchType?: InvalidateQueryFilters["refetchType"],
): Promise<unknown> {
  return Promise.all(
    paths.map((path) => qc.invalidateQueries({ queryKey: ["get", path], refetchType })),
  );
}

/** The org detail, incl. `storage.used_bytes` behind every gauge and the quota alert: any write changing the org's bytes MUST invalidate it. */
export function invalidateOrgDetail(qc: QueryClient): Promise<unknown> {
  return invalidatePaths(qc, ["/api/orgs/{orgId}"]);
}

/** Single run detail + its log list. Patched live by the run SSE stream. */
export const runKeys = {
  /** Prefix — every run-detail entry. Does NOT reach {@link runKeys.logs} (`["run"]` is not a prefix of `["run-logs", …]`); see {@link invalidateRunLogs}. */
  all: ["run"] as const,
  logsAll: ["run-logs"] as const,
  detail: (orgId: Id, spaceId: Id, runId: Id) => ["run", orgId, spaceId, runId] as const,
  logs: (orgId: Id, spaceId: Id, runId: Id) => ["run-logs", orgId, spaceId, runId] as const,
};

/**
 * Refetch one run's log list. The global terminal-status invalidation fires `runKeys.all` and
 * leaves this family alone, which costs more than a stale list: live SSE frames and the turns
 * table's per-turn breadcrumbs ride in this cache, so a frame arriving before stream teardown is
 * lost for good.
 */
export function invalidateRunLogs(qc: QueryClient, orgId: Id, spaceId: Id, runId: Id) {
  return qc.invalidateQueries({ queryKey: runKeys.logs(orgId, spaceId, runId) });
}

/** Refetch every cached run detail when the file's container is unknown at the call site: deleting a produced file changes `file_counts` (tab badge, single-file rule). */
export function invalidateRunDetails(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: runKeys.all });
}

/** Keyset-paged run lists (runs page, agent runs tab, schedule runs tab). */
export const paginatedRunsKeys = {
  all: ["paginated-runs"] as const,
  list: (
    orgId: Id,
    spaceId: Id,
    endpoint: string,
    user: string | null | undefined,
    kind: string | null | undefined,
    status: string | null | undefined,
    unread: boolean | undefined,
    search: string | null | undefined,
    limit: number,
    spaceKind?: SpaceKind,
  ) =>
    [
      "paginated-runs",
      orgId,
      spaceId,
      endpoint,
      user,
      kind,
      status,
      unread,
      // Before `search, limit`, which stay last: `placeholderData` keeps rows across a search change only (`keepsRunRows`).
      spaceKind,
      search,
      limit,
    ] as const,
};

/** Package caches; `path` is the plural route segment (`"agents"`, `"skills"`, …), NOT the singular type. */
export const packageKeys = {
  all: ["packages"] as const,
  family: (path: string) => ["packages", path] as const,
  familyInOrg: (path: string, orgId: Id) => ["packages", path, orgId] as const,
  list: (path: string, orgId: Id, spaceId: Id) => ["packages", path, orgId, spaceId] as const,
  detail: (path: string, orgId: Id, spaceId: Id, id: string, version: string | null = null) =>
    ["packages", path, orgId, spaceId, id, version] as const,
};

/**
 * The file explorer's two caches: openapi-react-query keys listed here because mutations that
 * know nothing about the explorer must invalidate them. Any write changing the DRAFT artifact
 * has to fire this: the index carries each text file's `inline` content, so a stale entry renders
 * the pre-edit source, then heals itself when stale (hard to report).
 */
export function invalidatePackageFiles(qc: QueryClient) {
  void invalidatePaths(qc, [
    "/api/packages/{scope}/{name}/files",
    "/api/packages/{scope}/{name}/files/content",
  ]);
}

/** Typed-client keys of the version reads (list, detail, info), whose path carries the type's route segment. */
const VERSION_PATH = /^\/api\/packages\/[^/]+\/\{scope\}\/\{name\}\/versions(\/|$)/;
const VERSION_INFO_PATH = /^\/api\/packages\/[^/]+\/\{scope\}\/\{name\}\/versions\/info$/;

function pathMatching(re: RegExp) {
  return (queryKey: readonly unknown[]) =>
    queryKey[0] === "get" && typeof queryKey[1] === "string" && re.test(queryKey[1]);
}

/** The latest/active summary of every package's versions. */
export function invalidateVersionInfo(qc: QueryClient) {
  const matches = pathMatching(VERSION_INFO_PATH);
  return qc.invalidateQueries({ predicate: (q) => matches(q.queryKey) });
}

/** Agent catalog list (sidebar, agent list page). */
export const agentsKeys = {
  all: ["agents"] as const,
  inOrg: (orgId: Id) => ["agents", orgId] as const,
  list: (orgId: Id, spaceId: Id) => ["agents", orgId, spaceId] as const,
};

/** A package write: every package family, the agent catalog and the file explorer's caches. */
export function invalidatePackageCaches(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: agentsKeys.all });
  void qc.invalidateQueries({ queryKey: packageKeys.all });
  invalidatePackageFiles(qc);
}

/** A version appeared or vanished: the version caches, and a pinned Files tab or dist-tag read with them. */
export function invalidateVersionCaches(qc: QueryClient) {
  const matches = pathMatching(VERSION_PATH);
  void qc.invalidateQueries({ predicate: (q) => matches(q.queryKey) });
  invalidatePackageCaches(qc);
}

/** Schedule caches. Patched by the run SSE stream when a run carries a scheduleId. */
export const scheduleKeys = {
  listAll: ["schedules"] as const,
  detailAll: ["schedule"] as const,
  runsAll: ["schedule-runs"] as const,
  list: (orgId: Id, spaceId: Id) => ["schedules", orgId, spaceId] as const,
  listForAgent: (orgId: Id, spaceId: Id, packageId: Id) =>
    ["schedules", orgId, spaceId, packageId] as const,
  detail: (orgId: Id, spaceId: Id, scheduleId: Id) =>
    ["schedule", orgId, spaceId, scheduleId] as const,
  runs: (orgId: Id, spaceId: Id, scheduleId: Id) =>
    ["schedule-runs", orgId, spaceId, scheduleId] as const,
};

/** Organization list (preserved across org switch). */
export const orgKeys = {
  all: ["orgs"] as const,
};

/** Drops every row answered under the previous authority (org switch, role preview); `["orgs"]` is spared because `OrgGate` blocks on it. */
export function removeOrgScopedQueries(qc: QueryClient) {
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== orgKeys.all[0] });
}

/** Per-actor agent persistence (memories + pinned slots). */
export const persistenceKeys = {
  all: ["agent-persistence"] as const,
  list: (orgId: Id, spaceId: Id, scopeTag: string, packageId: Id, query: unknown) =>
    ["agent-persistence", orgId, spaceId, scopeTag, packageId, query] as const,
};

/** A stored file's bytes as an object URL (`useFileImageSrc`); `query-client.ts` revokes the URL when the entry leaves the cache. */
export const fileBlobKeys = {
  root: "file-blob",
  detail: (id: string, scope: Record<string, string | undefined>) =>
    ["file-blob", id, scope] as const,
};
