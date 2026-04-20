// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * @appstrate/afps-runtime — portable runtime for AFPS agent bundles.
 *
 * This file is the package's public surface. Phase 2 of the extraction
 * plan ships types and interfaces only; implementations land in
 * subsequent phases (sinks in Phase 3, context providers in Phase 4,
 * credential providers in Phase 5, etc.).
 *
 * See `AFPS_EXTENSION_ARCHITECTURE.md` and `AFPS_RUNTIME_PLAN.md` at the
 * workspace root for the full design and phased sequence.
 */

export const VERSION = "0.0.0";

export * from "./interfaces/index.ts";
export * from "./types/index.ts";
export * from "./events/index.ts";
export * from "./sinks/index.ts";
export * from "./providers/index.ts";
export * from "./template/index.ts";
export * from "./bundle/index.ts";
export * from "./runner/index.ts";
export * from "./conformance/index.ts";
