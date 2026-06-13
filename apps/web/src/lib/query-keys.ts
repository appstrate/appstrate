// SPDX-License-Identifier: Apache-2.0

/**
 * Centralized React Query keys for the legacy-pinned cache families.
 *
 * These families are special: they are PRODUCED in one place (a fetch hook)
 * but PATCHED / INVALIDATED from another — the SSE stream in
 * `use-global-run-sync`, mutation `onSuccess` handlers, and org/app-switch
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

type Id = string | null | undefined;

/** Single run detail + its log list. Patched live by the run SSE stream. */
export const runKeys = {
  /** Prefix — every run-detail entry (terminal-status invalidation). */
  all: ["run"] as const,
  detail: (orgId: Id, applicationId: Id, runId: Id) =>
    ["run", orgId, applicationId, runId] as const,
  logs: (orgId: Id, applicationId: Id, runId: Id) =>
    ["run-logs", orgId, applicationId, runId] as const,
};

/** Per-agent run list. Patched in place by the run SSE stream. */
export const runsKeys = {
  /** Prefix — every per-agent run list. */
  all: ["runs"] as const,
  forAgent: (orgId: Id, applicationId: Id, packageId: Id) =>
    ["runs", orgId, applicationId, packageId] as const,
};

/** Cursor/offset-paginated run tables (runs page, agent runs tab). */
export const paginatedRunsKeys = {
  /** Prefix — invalidates every paginated-runs query. */
  all: ["paginated-runs"] as const,
  list: (
    orgId: Id,
    applicationId: Id,
    endpoint: string,
    user: string | null | undefined,
    kind: string | null | undefined,
    status: string | null | undefined,
    limit: number,
    offset: number,
  ) =>
    ["paginated-runs", orgId, applicationId, endpoint, user, kind, status, limit, offset] as const,
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
  list: (path: string, orgId: Id, applicationId: Id, filter: string) =>
    ["packages", path, orgId, applicationId, filter] as const,
  detail: (path: string, orgId: Id, applicationId: Id, id: string) =>
    ["packages", path, orgId, applicationId, id] as const,
};

/** Agent catalog list (sidebar, agent list page). */
export const agentsKeys = {
  /** Prefix — every agents query. */
  all: ["agents"] as const,
  /** Org-scoped prefix (`["agents",orgId]`). */
  inOrg: (orgId: Id) => ["agents", orgId] as const,
  list: (orgId: Id, applicationId: Id) => ["agents", orgId, applicationId] as const,
};

/** Schedule caches. Patched by the run SSE stream when a run carries a scheduleId. */
export const scheduleKeys = {
  /** Prefix — every schedule-list query. */
  listAll: ["schedules"] as const,
  /** Prefix — every single-schedule query. */
  detailAll: ["schedule"] as const,
  list: (orgId: Id, applicationId: Id) => ["schedules", orgId, applicationId] as const,
  listForAgent: (orgId: Id, applicationId: Id, packageId: Id) =>
    ["schedules", orgId, applicationId, packageId] as const,
  detail: (orgId: Id, applicationId: Id, scheduleId: Id) =>
    ["schedule", orgId, applicationId, scheduleId] as const,
  runs: (orgId: Id, applicationId: Id, scheduleId: Id) =>
    ["schedule-runs", orgId, applicationId, scheduleId] as const,
};

/** Per-agent effective model resolution. */
export const agentModelKeys = {
  all: ["agent-model"] as const,
  detail: (orgId: Id, applicationId: Id, packageId: Id) =>
    ["agent-model", orgId, applicationId, packageId] as const,
};

/** Per-agent effective proxy resolution. */
export const agentProxyKeys = {
  all: ["agent-proxy"] as const,
  detail: (orgId: Id, applicationId: Id, packageId: Id) =>
    ["agent-proxy", orgId, applicationId, packageId] as const,
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
  list: (scopeTag: string, orgId: Id, applicationId: Id, packageId: Id, query: unknown) =>
    ["agent-persistence", scopeTag, orgId, applicationId, packageId, query] as const,
};
