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

type Id = string | null | undefined;

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

/** Cursor/offset-paginated run tables (runs page, agent runs tab). */
export const paginatedRunsKeys = {
  all: ["paginated-runs"] as const,
  list: (
    orgId: Id,
    spaceId: Id,
    endpoint: string,
    user: string | null | undefined,
    kind: string | null | undefined,
    status: string | null | undefined,
    search: string | null | undefined,
    limit: number,
    offset: number,
  ) =>
    [
      "paginated-runs",
      orgId,
      spaceId,
      endpoint,
      user,
      kind,
      status,
      search,
      // The OFFSET stays last: `placeholderData` keeps rows only when everything before it matched (paging vs a changed question).
      limit,
      offset,
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

/** Package versions: the published list, one version's detail, and the latest/active summary. */
export const versionKeys = {
  detailAll: ["version-detail"] as const,
  listAll: ["package-versions"] as const,
  infoAll: ["version-info"] as const,
  detail: (orgId: Id, spaceId: Id, type: string, packageId: Id, version: string | undefined) =>
    ["version-detail", orgId, spaceId, type, packageId, version] as const,
  list: (orgId: Id, spaceId: Id, type: string, packageId: Id) =>
    ["package-versions", orgId, spaceId, type, packageId] as const,
  info: (orgId: Id, spaceId: Id, type: string, packageId: Id) =>
    ["version-info", orgId, spaceId, type, packageId] as const,
};

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
  for (const queryKey of [versionKeys.listAll, versionKeys.detailAll, versionKeys.infoAll]) {
    void qc.invalidateQueries({ queryKey });
  }
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

function agentSettingKeys<K extends string>(kind: K) {
  return {
    all: [kind] as const,
    detail: (orgId: Id, spaceId: Id, packageId: Id) => [kind, orgId, spaceId, packageId] as const,
  };
}

/** Per-agent effective model resolution. */
export const agentModelKeys = agentSettingKeys("agent-model");

/** Per-agent effective proxy resolution. */
export const agentProxyKeys = agentSettingKeys("agent-proxy");

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
  list: (scopeTag: string, orgId: Id, spaceId: Id, packageId: Id, query: unknown) =>
    ["agent-persistence", scopeTag, orgId, spaceId, packageId, query] as const,
};
