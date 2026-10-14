// SPDX-License-Identifier: Apache-2.0

/**
 * Centralized React Query keys for the legacy-pinned cache families.
 *
 * These families are special: they are PRODUCED in one place (a fetch hook)
 * but PATCHED / INVALIDATED from another — the SSE stream in
 * `use-global-run-sync`, mutation `onSuccess` handlers, and org/space-switch
 * resets. When the producer and a remote patcher hand-write the key array
 * independently they can silently drift (the `["packages","agent"]` vs
 * `["packages","agents"]` singular/plural no-op was exactly this). Building
 * every key from one typed module makes that drift a compile error instead of
 * a runtime no-op.
 *
 * The openapi-react-query hooks use their own `[method, path, init]` keys; the
 * hand-rolled legacy keys live in this file, and `invalidatePaths` is the typed
 * way to invalidate the others.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { paths } from "../api/schema";

type Id = string | null | undefined;

/** A spec path that has a GET operation: the only paths a query key can name. */
export type GetPath = {
  [P in keyof paths]: paths[P] extends { get: object } ? P : never;
}[keyof paths];

/**
 * Invalidate typed-client queries by spec path. openapi-react-query keys are
 * `[method, path, init]` with the literal spec path, so the path alone is a
 * prefix of every entry under it; typing it against the generated spec turns a
 * typo into a compile error instead of an invalidation that matches nothing.
 * `refetchType: "none"` marks the entries stale without refetching them.
 */
export function invalidatePaths(
  qc: QueryClient,
  paths: readonly GetPath[],
  refetchType?: "none",
): Promise<unknown> {
  return Promise.all(
    paths.map((path) => qc.invalidateQueries({ queryKey: ["get", path], refetchType })),
  );
}

/**
 * The current org's detail: members, invitations and `storage.used_bytes`, the
 * number behind every storage gauge and the "quota reached" alert. Any write
 * that changes how many bytes the org holds (delete, keep, upload) MUST call
 * this, or the gauge and the alert stay frozen on the old value.
 */
export function invalidateOrgDetail(qc: QueryClient): Promise<unknown> {
  return invalidatePaths(qc, ["/api/orgs/{orgId}"]);
}

/** Single run detail + its log list. Patched live by the run SSE stream. */
export const runKeys = {
  /**
   * Prefix — every run-detail entry (terminal-status invalidation).
   *
   * It does NOT reach {@link runKeys.logs}: React Query prefix-matches element
   * by element, and `["run"]` is not a prefix of `["run-logs", …]`. The logs
   * cache is a separate family that has to be invalidated by name — see
   * {@link invalidateRunLogs}.
   */
  all: ["run"] as const,
  /** Prefix — every run-logs entry. */
  logsAll: ["run-logs"] as const,
  detail: (orgId: Id, spaceId: Id, runId: Id) => ["run", orgId, spaceId, runId] as const,
  logs: (orgId: Id, spaceId: Id, runId: Id) => ["run-logs", orgId, spaceId, runId] as const,
};

/**
 * Refetch one run's log list.
 *
 * Its own function, in the module that owns the key, because the global
 * terminal-status invalidation (`invalidateRunAndNotificationQueries`, in
 * `use-notifications.ts`) fires `runKeys.all` — which refetches the run row and
 * silently leaves this family alone.
 *
 * That costs more than a stale log list. The run-detail page appends live SSE
 * frames into this cache with `setQueryData`, and the per-turn breadcrumbs the
 * turns table reads (each turn's context and the window) ride in it: a frame
 * arriving between the last render and the stream teardown is lost for good,
 * leaving the table without its last turns — or, with no window left in the
 * cache, without its percentages.
 */
export function invalidateRunLogs(qc: QueryClient, orgId: Id, spaceId: Id, runId: Id) {
  return qc.invalidateQueries({ queryKey: runKeys.logs(orgId, spaceId, runId) });
}

/**
 * Refetch every cached run detail after a mutation whose file container is
 * not available at the hook call site. Deleting a produced file changes the
 * run's `file_counts`, which is what the run page's tab badge and its
 * single-file presentation rule are derived from; invalidating only
 * file queries would leave the page counting a row that no longer exists.
 */
export function invalidateRunDetails(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: runKeys.all });
}

/** Cursor/offset-paginated run tables (runs page, agent runs tab). */
export const paginatedRunsKeys = {
  /** Prefix — invalidates every paginated-runs query. */
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
      // The OFFSET stays last: `placeholderData` keeps the rows on screen only
      // when everything before it matched, which is what tells paging apart
      // from a changed question.
      limit,
      offset,
    ] as const,
};

/**
 * Package caches (agents/skills/mcp-servers/integrations). `path` is the
 * plural route segment (`"agents"`, `"skills"`, …) — NOT the singular type.
 */
export const packageKeys = {
  /** Prefix — every package cache across all families (`["packages"]`). */
  all: ["packages"] as const,
  /** Prefix — every cache for a package family (`["packages","agents"]`). */
  family: (path: string) => ["packages", path] as const,
  /** Org-scoped family prefix (`["packages","agents",orgId]`). */
  familyInOrg: (path: string, orgId: Id) => ["packages", path, orgId] as const,
  list: (path: string, orgId: Id, spaceId: Id) => ["packages", path, orgId, spaceId] as const,
  detail: (path: string, orgId: Id, spaceId: Id, id: string, version: string | null = null) =>
    ["packages", path, orgId, spaceId, id, version] as const,
};

/**
 * The file explorer's two caches. Unlike everything else in this file these ARE
 * openapi-react-query keys (`[method, path, init]`), listed here because they
 * share the family's defining problem: they are produced by the explorer and
 * must be invalidated from mutations that know nothing about it.
 *
 * Any write that changes the DRAFT artifact has to fire this. The index carries
 * each text file's content in `inline`, so a stale entry does not merely lag —
 * it renders the pre-edit source of a file the user just saved, and then heals
 * itself when the query goes stale, which is what makes it hard to report.
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
  /** Prefix — every agents query. */
  all: ["agents"] as const,
  /** Org-scoped prefix (`["agents",orgId]`). */
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
  /** Prefix — every schedule-list query. */
  listAll: ["schedules"] as const,
  /** Prefix — every single-schedule query. */
  detailAll: ["schedule"] as const,
  /** Prefix — every schedule-runs query. */
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

/**
 * Drop every cached row that was answered under the previous authority — an
 * org switch, and entering or leaving a role preview. `["orgs"]` is spared
 * because `OrgGate` blocks on it, and removing it flashes the boot screen.
 */
export function removeOrgScopedQueries(qc: QueryClient) {
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== orgKeys.all[0] });
}

/** Per-actor agent persistence (memories + pinned slots). */
export const persistenceKeys = {
  all: ["agent-persistence"] as const,
  list: (scopeTag: string, orgId: Id, spaceId: Id, packageId: Id, query: unknown) =>
    ["agent-persistence", scopeTag, orgId, spaceId, packageId, query] as const,
};
