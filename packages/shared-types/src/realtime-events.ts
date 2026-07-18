// SPDX-License-Identifier: Apache-2.0

/**
 * Shared Zod schemas for the realtime SSE boundary — the single source of
 * truth for every `event: …` frame the platform broadcasts.
 *
 * These describe the **post-camelize wire shape** the client receives, NOT
 * the upstream PG NOTIFY payload. `apps/api/src/services/realtime.ts`
 * shallow-camelizes the NOTIFY JSON (top-level keys only) before sending, so:
 *   - top-level keys are camelCase (`packageId`, `startedAt`, `tokenUsage`)
 *   - inner objects keep their snake_case keys (`token_usage` →
 *     `tokenUsage: { input_tokens, … }`) because the camelize is shallow.
 *
 * The server validates each payload against these on emit (drift in a
 * trigger/broadcaster surfaces as a logged error, never a silent client
 * cast failure); the client `safeParse`s them on receipt (no more
 * hand-written event types drifting from the wire).
 */
import { z } from "zod";
import { tokenUsageSchema } from "@appstrate/core/token-usage";
import { runStatusEnum } from "@appstrate/db/schema";
import type { RunWireDto } from "./index.ts";

/** `run_update` — emitted by the `notify_run_change` trigger (13 fields). */
export const runUpdateEventSchema = z.object({
  operation: z.enum(["INSERT", "UPDATE"]),
  id: z.string(),
  packageId: z.string().nullable(),
  status: z.enum(runStatusEnum.enumValues),
  userId: z.string().nullable(),
  endUserId: z.string().nullable(),
  orgId: z.string(),
  applicationId: z.string(),
  scheduleId: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  duration: z.number().nullable(),
});
export type RunUpdateEvent = z.infer<typeof runUpdateEventSchema>;

/**
 * `run_log` — emitted by the `notify_run_log_insert` trigger. `data` is the
 * log's JSONB, or the literal string `"[payload too large]"` when the row
 * exceeds the NOTIFY size budget, or omitted for non-verbose subscribers
 * (the server strips it via `stripPayload`).
 */
export const runLogEventSchema = z.object({
  id: z.number(),
  runId: z.string(),
  orgId: z.string(),
  applicationId: z.string().nullable(),
  type: z.string(),
  level: z.enum(["debug", "info", "warn", "error"]),
  event: z.string().nullable(),
  message: z.string().nullable(),
  data: z
    .union([z.record(z.string(), z.unknown()), z.string()])
    .nullable()
    .optional(),
  createdAt: z.string(),
});
export type RunLogEvent = z.infer<typeof runLogEventSchema>;

/** `run_metric` — application-emitted running cost + cumulative token usage. */
export const runMetricEventSchema = z.object({
  runId: z.string(),
  orgId: z.string(),
  applicationId: z.string(),
  packageId: z.string(),
  // Inner object keeps snake_case keys (shallow camelize). Reuse the
  // canonical token-usage schema rather than redefining it.
  tokenUsage: tokenUsageSchema.nullable(),
  costSoFar: z.number(),
});
export type RunMetricEvent = z.infer<typeof runMetricEventSchema>;

/** `connection_update` — `integration_connections` INSERT/UPDATE/DELETE. */
export const connectionUpdateEventSchema = z.object({
  operation: z.enum(["INSERT", "UPDATE", "DELETE"]),
  id: z.string(),
  integrationPackageId: z.string(),
  authKey: z.string().nullable(),
  userId: z.string().nullable(),
  endUserId: z.string().nullable(),
  applicationId: z.string(),
  // NULL on DELETE (the OLD row carries no live reconnection flag).
  needsReconnection: z.boolean().nullable(),
  deleted: z.boolean(),
});
export type ConnectionUpdateEvent = z.infer<typeof connectionUpdateEventSchema>;

/**
 * `chat_session_update` — application-emitted by the chat module whenever a
 * session row changes (message persisted, read-marker advanced, rename,
 * delete, create, `generating` flip). A change SIGNAL, not event-carried
 * state: the payload identifies the owner for fan-out filtering and the
 * consumer refetches the session list (stale-while-revalidate), so the DTO
 * stays single-sourced in the chat routes. The payload deliberately omits
 * `application_id` — `chat_sessions` is org+user scoped, not app scoped.
 */
export const chatSessionUpdateEventSchema = z.object({
  sessionId: z.string(),
  orgId: z.string(),
  userId: z.string(),
});
export type ChatSessionUpdateEvent = z.infer<typeof chatSessionUpdateEventSchema>;

/**
 * Discriminated union of every typed SSE frame. (`ping` is intentionally
 * absent — its `data` is an empty string, not JSON, and no consumer parses
 * it; it exists only as a keep-alive.)
 */
export type RealtimeEvent =
  | { event: "run_update"; data: RunUpdateEvent }
  | { event: "run_log"; data: RunLogEvent }
  | { event: "run_metric"; data: RunMetricEvent }
  | { event: "connection_update"; data: ConnectionUpdateEvent }
  | { event: "chat_session_update"; data: ChatSessionUpdateEvent };

/**
 * Translate a `run_update` SSE frame into a `RunWireDto` patch.
 *
 * Required because the wire frame is camelCase (`startedAt`/`completedAt`)
 * but `RunWireDto` keeps those two timestamps snake_case (`started_at`/
 * `completed_at`) per the casing carve-out. A naive `{...prev, ...frame}`
 * spread would write NEW `startedAt`/`completedAt` keys alongside the stale
 * snake ones, so the cached row's timestamps/duration would never update
 * mid-run. This maps the overlapping fields onto their `RunWireDto` names.
 */
export function runUpdateToRunPatch(evt: RunUpdateEvent): Partial<RunWireDto> {
  return {
    id: evt.id,
    packageId: evt.packageId,
    status: evt.status,
    userId: evt.userId,
    endUserId: evt.endUserId,
    orgId: evt.orgId,
    applicationId: evt.applicationId,
    scheduleId: evt.scheduleId,
    error: evt.error,
    started_at: evt.startedAt,
    completed_at: evt.completedAt,
    duration: evt.duration,
  };
}
