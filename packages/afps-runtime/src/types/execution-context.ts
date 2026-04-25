// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Execution Context — the runtime state passed to an AFPS runner at boot.
 *
 * Contains everything that varies between runs (input, prior memories,
 * previous state, sink wiring, credential source). MUST NOT contain
 * authentication material: the HMAC secret used to sign events, API
 * keys, and OAuth tokens all travel through separate channels (env
 * variables, secret files) so that exporting a `context.json` for debug
 * or replay never leaks a usable credential.
 *
 * Specification: see `AFPS_EXTENSION_ARCHITECTURE.md` §3 constraint 3, §7.
 */

import { z } from "zod";

const memorySnapshotSchema = z.object({
  content: z.string(),
  createdAt: z.number(),
});

const historyEntrySchema = z.object({
  runId: z.string(),
  timestamp: z.number(),
  output: z.unknown(),
});

const consoleSinkConfigSchema = z.object({
  type: z.literal("console"),
});

const fileSinkConfigSchema = z.object({
  type: z.literal("file"),
  path: z.string().min(1),
});

const httpSinkConfigSchema = z.object({
  type: z.literal("http"),
  url: z.url(),
  // NOTE: no `auth` field here by design. Run secret comes from:
  //   - AFPS_SINK_SECRET env var
  //   - --sink-auth @file:/path/to/secret flag
  //   - stdin
  // See AFPS_EXTENSION_ARCHITECTURE.md §3 constraint 3.
});

const sinkConfigSchema = z.discriminatedUnion("type", [
  consoleSinkConfigSchema,
  fileSinkConfigSchema,
  httpSinkConfigSchema,
]);

const credentialsConfigSchema = z.object({
  type: z.enum(["appstrate", "file", "env", "vault"]),
  endpoint: z.url().optional(),
  path: z.string().min(1).optional(),
});

const contextSourceConfigSchema = z.object({
  type: z.enum(["appstrate", "file", "snapshot", "noop"]),
  endpoint: z.url().optional(),
  path: z.string().min(1).optional(),
});

const modelRefSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  apiKeyRef: z.string().optional(), // reference, never literal
});

/**
 * Zod schema for {@link ExecutionContext}. Use {@link executionContextSchema.safeParse}
 * to validate untrusted input (e.g. a `context.json` file) before the
 * runtime consumes it.
 */
export const executionContextSchema = z.object({
  // Required
  runId: z.string().min(1),
  input: z.unknown(),

  // Optional — absence means the corresponding feature is naturally inactive.
  // See AFPS_EXTENSION_ARCHITECTURE.md §3.2 "pure template / impure context".
  memories: z.array(memorySnapshotSchema).optional(),
  state: z.unknown().optional(),
  history: z.array(historyEntrySchema).optional(),

  /**
   * Agent-config values resolved for this run. Surfaced to 1.1+ templates
   * as `{{config.*}}`. Absent when the agent declares no config schema.
   */
  config: z.record(z.string(), z.unknown()).optional(),

  // Runtime wiring (no auth material — see note above)
  sink: sinkConfigSchema.optional(),
  credentials: credentialsConfigSchema.optional(),
  context: contextSourceConfigSchema.optional(),
  model: modelRefSchema.optional(),

  // Reproducibility knobs
  dryRun: z.boolean().optional(),
  traceparent: z.string().optional(), // W3C Trace Context
});

export type ExecutionContext = z.infer<typeof executionContextSchema>;

export type MemorySnapshot = z.infer<typeof memorySnapshotSchema>;
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export type SinkConfig = z.infer<typeof sinkConfigSchema>;
export type CredentialsConfig = z.infer<typeof credentialsConfigSchema>;
export type ContextSourceConfig = z.infer<typeof contextSourceConfigSchema>;
export type ModelRef = z.infer<typeof modelRefSchema>;
