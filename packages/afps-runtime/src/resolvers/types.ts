// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Runtime-internal TypeScript interfaces for `@appstrate/afps-runtime`.
 *
 * Spec-level contracts (Tool protocol, RunEvent envelope, manifest refs)
 * are re-exported from `@afps-spec/types` — the vendor-neutral projection of
 * the AFPS spec. Everything declared here describes how THIS runtime
 * wires itself up internally (resolver dispatch, sink composition,
 * aggregated run state) and is intentionally not part of the spec.
 */

import type { Bundle, BundlePackage } from "../bundle/types.ts";

export type {
  DependencyRef,
  ToolRef,
  ProviderRef,
  SkillRef,
  JSONSchema,
  Tool,
  ToolContext,
  ToolResult,
  RunEvent,
} from "@afps-spec/types";

import type { ToolRef, ProviderRef, SkillRef, Tool } from "@afps-spec/types";

// ─────────────────────────────────────────────
// Bundle surface passed to resolvers — the spec {@link Bundle} is the
// single contract. Each resolver looks up its dependencies via
// {@link resolvePackageRef} against {@link Bundle.packages}.
// ─────────────────────────────────────────────

export type { Bundle, BundlePackage };

// ─────────────────────────────────────────────
// Resolver outputs (runtime-internal)
// ─────────────────────────────────────────────

export interface ResolvedSkill {
  name: string;
  version: string;
  content: string;
  frontmatter?: Record<string, unknown>;
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
