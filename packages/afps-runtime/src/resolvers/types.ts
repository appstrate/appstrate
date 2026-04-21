// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS 1.3 runtime interface types — normative shape defined by the
 * spec (see `afps-spec/schema/src/interfaces.ts`). Declared here rather
 * than re-exported from `@afps-spec/schema/interfaces` so the runtime
 * can evolve on its own release cadence without pinning to a specific
 * spec package version for type resolution. The shapes are kept in
 * lockstep with the spec and any divergence is a runtime bug.
 */

import type { RunEvent } from "../types/run-event.ts";
import type { RunResult as LegacyRunResult } from "../types/run-result.ts";

// ─────────────────────────────────────────────
// Bundle surface passed to resolvers
// ─────────────────────────────────────────────

export interface Bundle {
  manifest: unknown;
  digest: string;
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

// ─────────────────────────────────────────────
// Dependency refs
// ─────────────────────────────────────────────

export interface DependencyRef {
  name: string;
  version: string;
}
export type ToolRef = DependencyRef;
export type ProviderRef = DependencyRef;
export type SkillRef = DependencyRef;

export interface PreludeRef extends DependencyRef {
  optional?: boolean;
}

// ─────────────────────────────────────────────
// Tool surface — what the LLM sees
// ─────────────────────────────────────────────

export type JSONSchema = Record<string, unknown>;

export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  emit(event: RunEvent): void;
  workspace: string;
  signal: AbortSignal;
  runId: string;
  toolCallId?: string;
}

export interface ToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "resource"; uri: string; mimeType?: string }
  >;
  isError?: boolean;
}

// ─────────────────────────────────────────────
// Resolver outputs
// ─────────────────────────────────────────────

export interface ResolvedSkill {
  name: string;
  version: string;
  content: string;
  frontmatter?: Record<string, unknown>;
}

export interface ResolvedPrelude {
  name: string;
  version: string;
  content: string;
}

// ─────────────────────────────────────────────
// Resolvers
// ─────────────────────────────────────────────

export interface ToolResolver {
  resolve(refs: ToolRef[], bundle: Bundle): Promise<Tool[]>;
}

export interface ProviderResolver {
  resolve(refs: ProviderRef[], bundle: Bundle): Promise<Tool[]>;
}

export interface SkillResolver {
  resolve(refs: SkillRef[], bundle: Bundle): Promise<ResolvedSkill[]>;
}

export interface PreludeResolver {
  resolve(refs: PreludeRef[], bundle: Bundle): Promise<ResolvedPrelude[]>;
}

// ─────────────────────────────────────────────
// Accumulated end-of-run state (spec shape — superset of legacy)
// ─────────────────────────────────────────────

/**
 * Spec-shaped run result. Extends the legacy {@link LegacyRunResult} so
 * existing reducers remain compatible — fields the spec adds are
 * optional, and the legacy fields (memories/logs/error) live on
 * {@link LegacyRunResult} unchanged.
 */
export interface SpecRunResult {
  status: "success" | "failed" | "timeout" | "cancelled";
  output?: unknown;
  report?: string;
  state?: unknown;
  metadata?: Record<string, unknown>;
}

// Re-export the legacy shape under its canonical name for callers that
// need both.
export type { LegacyRunResult };
