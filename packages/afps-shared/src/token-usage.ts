// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical token-usage shape reported by an LLM provider for a completion.
 *
 * Wire format is snake_case (AFPS `appstrate.metric` event, the platform's
 * `runs.tokenUsage` JSONB column, the runner-event ingestion route, and every
 * cost-accounting consumer). All four fields are OPTIONAL — this is the widest
 * shape and matches wire reality where usage may be partial. It is the single
 * definition re-exported by `@appstrate/core/token-usage`,
 * `@appstrate/shared-types`, `@appstrate/afps-runtime`, the Drizzle schema, the
 * web realtime hooks, and the CLI runner.
 */
export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}
