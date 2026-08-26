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
 * The openapi-react-query hooks use their own `[method, path, init]` keys and
 * are NOT covered here — only the hand-rolled legacy keys live in this file.
 *
 * Each builder returns a readonly tuple; the shapes are byte-for-byte the same
 * arrays these caches have always used (a pure refactor).
 */

import type { QueryClient } from "@tanstack/react-query";

type Id = string | null | undefined;

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
 * frames into this cache with `setQueryData`, and the per-turn breadcrumbs
 * carrying BOTH the context gauge's numerator and its denominator ride in it: a
 * frame arriving between the last render and the stream teardown is lost for
 * good, leaving a run that peaked at 187k reporting whatever the last surviving
 * turn said — or, with no window left in the cache, no gauge at all.
 */
export function invalidateRunLogs(qc: QueryClient, orgId: Id, spaceId: Id, runId: Id) {
  return qc.invalidateQueries({ queryKey: runKeys.logs(orgId, spaceId, runId) });
}

/**
 * Refetch every cached run detail after a mutation whose file container is
 * not available at the hook call site. Deleting a produced file changes the
 * run's `file_counts`, which is what the run page's tab badge and its
 * single-file presentation rule (#1177) are derived from; invalidating only
 * file queries would leave the page counting a row that no longer exists.
 */
export function invalidateRunDetails(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: runKeys.all });
}

/** Per-agent run list. Patched in place by the run SSE stream. */
export const runsKeys = {
  /** Prefix — every per-agent run list. */
  all: ["runs"] as const,
  forAgent: (orgId: Id, spaceId: Id, packageId: Id) => ["runs", orgId, spaceId, packageId] as const,
};

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
    limit: number,
    offset: number,
  ) => ["paginated-runs", orgId, spaceId, endpoint, user, kind, status, limit, offset] as const,
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
  list: (path: string, orgId: Id, spaceId: Id, filter: string) =>
    ["packages", path, orgId, spaceId, filter] as const,
  detail: (path: string, orgId: Id, spaceId: Id, id: string, version: string = "draft") =>
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
  void qc.invalidateQueries({ queryKey: ["get", "/api/packages/{scope}/{name}/files"] });
  void qc.invalidateQueries({ queryKey: ["get", "/api/packages/{scope}/{name}/files/content"] });
}

/** Agent catalog list (sidebar, agent list page). */
export const agentsKeys = {
  /** Prefix — every agents query. */
  all: ["agents"] as const,
  /** Org-scoped prefix (`["agents",orgId]`). */
  inOrg: (orgId: Id) => ["agents", orgId] as const,
  list: (orgId: Id, spaceId: Id) => ["agents", orgId, spaceId] as const,
};

/** Schedule caches. Patched by the run SSE stream when a run carries a scheduleId. */
export const scheduleKeys = {
  /** Prefix — every schedule-list query. */
  listAll: ["schedules"] as const,
  /** Prefix — every single-schedule query. */
  detailAll: ["schedule"] as const,
  list: (orgId: Id, spaceId: Id) => ["schedules", orgId, spaceId] as const,
  listForAgent: (orgId: Id, spaceId: Id, packageId: Id) =>
    ["schedules", orgId, spaceId, packageId] as const,
  detail: (orgId: Id, spaceId: Id, scheduleId: Id) =>
    ["schedule", orgId, spaceId, scheduleId] as const,
  runs: (orgId: Id, spaceId: Id, scheduleId: Id) =>
    ["schedule-runs", orgId, spaceId, scheduleId] as const,
};

/** Per-agent effective model resolution. */
export const agentModelKeys = {
  all: ["agent-model"] as const,
  detail: (orgId: Id, spaceId: Id, packageId: Id) =>
    ["agent-model", orgId, spaceId, packageId] as const,
};

/** Per-agent effective proxy resolution. */
export const agentProxyKeys = {
  all: ["agent-proxy"] as const,
  detail: (orgId: Id, spaceId: Id, packageId: Id) =>
    ["agent-proxy", orgId, spaceId, packageId] as const,
};

/** Cloud billing summary (org-scoped). */
export const billingKeys = {
  forOrg: (orgId: Id) => ["billing", orgId] as const,
};

/** Organization list (preserved across org switch). */
export const orgKeys = {
  all: ["orgs"] as const,
};

/** Per-actor agent persistence (memories + pinned slots). */
export const persistenceKeys = {
  all: ["agent-persistence"] as const,
  list: (scopeTag: string, orgId: Id, spaceId: Id, packageId: Id, query: unknown) =>
    ["agent-persistence", scopeTag, orgId, spaceId, packageId, query] as const,
};
