// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS Runtime Event Protocol (v1)
 *
 * The canonical set of events a running agent emits. Every AFPS-compliant
 * runner understands these five types. Unknown event types are forwarded
 * unchanged so future additions (`progress`, `checkpoint`, `notification`,
 * …) do not break existing sinks.
 *
 * Events are produced by "platform tools" (add-memory, output, report,
 * set-state, log) that write a single JSON line to stdout. The runtime
 * parses each line, validates against `afpsEventSchema`, and routes the
 * event through the configured `EventSink`.
 *
 * Specification: see `AFPS_EXTENSION_ARCHITECTURE.md` §5.
 */

import { z } from "zod";

const logLevelSchema = z.enum(["info", "warn", "error"]);
export type LogLevel = z.infer<typeof logLevelSchema>;

const addMemorySchema = z.object({
  type: z.literal("add_memory"),
  content: z.string().min(1),
});

const setStateSchema = z.object({
  type: z.literal("set_state"),
  state: z.unknown(),
});

const outputSchema = z.object({
  type: z.literal("output"),
  data: z.unknown(),
});

const reportSchema = z.object({
  type: z.literal("report"),
  content: z.string(),
});

const logSchema = z.object({
  type: z.literal("log"),
  level: logLevelSchema,
  message: z.string(),
});

/**
 * Zod discriminated union for the five canonical AFPS event types.
 *
 * Runtime-validated on parse. Use {@link afpsEventSchema.safeParse} to
 * gracefully reject unknown shapes without throwing.
 */
export const afpsEventSchema = z.discriminatedUnion("type", [
  addMemorySchema,
  setStateSchema,
  outputSchema,
  reportSchema,
  logSchema,
]);

/**
 * The canonical set of events a running agent can emit.
 *
 * Consumers matching on `type` get exhaustive narrowing. Do not pattern-
 * match on `type: string` — always compare against the literal values to
 * preserve the discriminated-union benefits.
 */
export type AfpsEvent = z.infer<typeof afpsEventSchema>;

/**
 * Envelope attached by the runtime when an event is routed to an
 * {@link EventSink}. The runtime assigns `runId` from the execution
 * context and increments `sequence` monotonically per run.
 */
export interface AfpsEventEnvelope {
  runId: string;
  sequence: number;
  event: AfpsEvent;
}
