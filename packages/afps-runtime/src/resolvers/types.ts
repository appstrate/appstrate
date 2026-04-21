// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Runtime-internal TypeScript interfaces for `@appstrate/afps-runtime`.
 *
 * Spec-level contracts (Tool protocol, RunEvent envelope, manifest refs)
 * are re-exported from `@afps/types` — the vendor-neutral projection of
 * the AFPS spec. Everything declared here describes how THIS runtime
 * wires itself up internally (Bundle loader API, resolver dispatch,
 * sink composition, aggregated run state) and is intentionally not
 * part of the spec.
 */

import type { RunResult as LegacyRunResult } from "../types/run-result.ts";

export type {
  DependencyRef,
  ToolRef,
  ProviderRef,
  SkillRef,
  PreludeRef,
  JSONSchema,
  Tool,
  ToolContext,
  ToolResult,
  RunEvent,
} from "@afps/types";

import type { ToolRef, ProviderRef, SkillRef, PreludeRef, Tool, RunEvent } from "@afps/types";

// ─────────────────────────────────────────────
// Bundle surface passed to resolvers (runtime-internal)
// ─────────────────────────────────────────────

export interface Bundle {
  manifest: unknown;
  digest: string;
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

// ─────────────────────────────────────────────
// Resolver outputs (runtime-internal)
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
// Resolvers (runtime-internal)
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
// EventSink (runtime-internal)
// ─────────────────────────────────────────────

export interface EventSink {
  handle(event: RunEvent): Promise<void>;
  finalize?(): Promise<SpecRunResult>;
}

// ─────────────────────────────────────────────
// Accumulated end-of-run state (runtime-internal, superset of legacy)
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
