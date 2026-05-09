// SPDX-License-Identifier: Apache-2.0

/**
 * Co-located Drizzle `pgEnum` + Zod `z.enum` definitions. Each value
 * list is declared once as a `const` tuple and re-used for both —
 * adding a value updates the DB enum, the Zod validator, and the
 * inferred TS union in lockstep.
 *
 * Route handlers should import the `z*Enum` siblings from
 * `@appstrate/db/schema` (e.g. `zRunStatusEnum`) instead of
 * redeclaring literal arrays inline.
 */

import { z } from "zod";
import { pgEnum } from "drizzle-orm/pg-core";

export const orgRoleValues = ["owner", "admin", "member", "viewer"] as const;
export const orgRoleEnum = pgEnum("org_role", orgRoleValues);
export const zOrgRoleEnum = z.enum(orgRoleValues);
export type OrgRole = z.infer<typeof zOrgRoleEnum>;

export const runStatusValues = [
  "pending",
  "running",
  "success",
  "failed",
  "timeout",
  "cancelled",
] as const;
export const runStatusEnum = pgEnum("run_status", runStatusValues);
export const zRunStatusEnum = z.enum(runStatusValues);
export type RunStatus = z.infer<typeof zRunStatusEnum>;

/**
 * Terminal run statuses — runs in any of these states are no longer
 * progressing. Used by event-ingestion ordering, SSE invalidation,
 * and any caller that needs to short-circuit polling.
 */
export const terminalRunStatusValues = ["success", "failed", "timeout", "cancelled"] as const;
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(terminalRunStatusValues);
export type TerminalRunStatus = (typeof terminalRunStatusValues)[number];

/**
 * Active (non-terminal) run statuses — the run is still progressing.
 * Mirror of {@link TERMINAL_RUN_STATUSES} for callers that need to gate
 * UI on "in flight" rather than "done". Derived from the same const
 * tuple pattern so adding a new status to {@link runStatusValues} forces
 * an explicit decision about which set it belongs to.
 */
export const activeRunStatusValues = ["pending", "running"] as const;
export const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(activeRunStatusValues);
export type ActiveRunStatus = (typeof activeRunStatusValues)[number];

/**
 * RunEvent types that mark a run as terminal — `run.success`, `run.failed`,
 * `run.timeout`, `run.cancelled`. Mirrors `terminalRunStatusValues` but for
 * the event-stream side of the boundary.
 */
export const TERMINAL_RUN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "run.success",
  "run.failed",
  "run.timeout",
  "run.cancelled",
]);

export const invitationStatusValues = ["pending", "accepted", "expired", "cancelled"] as const;
export const invitationStatusEnum = pgEnum("invitation_status", invitationStatusValues);
export const zInvitationStatusEnum = z.enum(invitationStatusValues);
export type InvitationStatus = z.infer<typeof zInvitationStatusEnum>;

export const packageTypeValues = ["agent", "skill", "tool", "provider"] as const;
export const packageTypeEnum = pgEnum("package_type", packageTypeValues);
export const zPackageTypeEnum = z.enum(packageTypeValues);
export type PackageType = z.infer<typeof zPackageTypeEnum>;

export const packageSourceValues = ["local", "system"] as const;
export const packageSourceEnum = pgEnum("package_source", packageSourceValues);
export const zPackageSourceEnum = z.enum(packageSourceValues);
export type PackageSource = z.infer<typeof zPackageSourceEnum>;

/**
 * Source discriminator for `llm_usage` rows. Each source has its own
 * dedup key: `proxy` rows dedup on `request_id`, `runner` rows dedup on
 * `(run_id, sequence)`.
 */
export const llmUsageSourceValues = ["proxy", "runner"] as const;
export const llmUsageSourceEnum = pgEnum("llm_usage_source", llmUsageSourceValues);
export const zLlmUsageSourceEnum = z.enum(llmUsageSourceValues);
export type LlmUsageSource = z.infer<typeof zLlmUsageSourceEnum>;

/**
 * Distinguishes WHO controls the runner process — `platform` for
 * platform-managed Pi containers, `remote` for caller-managed runners
 * (CLI, GitHub Action, self-hosted). Closed set: every event-ingestion
 * code path branches on it, so adding a value is intentional.
 */
export const runOriginValues = ["platform", "remote"] as const;
export const runOriginEnum = pgEnum("run_origin", runOriginValues);
export const zRunOriginEnum = z.enum(runOriginValues);
export type RunOrigin = z.infer<typeof zRunOriginEnum>;
