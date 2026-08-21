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

export type { DependencyRef, JSONSchema, Tool, ToolContext, ToolResult } from "@afps-spec/types";

// ─────────────────────────────────────────────
// Bundle surface passed to resolvers — the spec {@link Bundle} is the
// single contract. Each resolver looks up its dependencies via
// {@link resolvePackageRef} against {@link Bundle.packages}.
// ─────────────────────────────────────────────

export type { Bundle, BundlePackage };
