// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical token-usage shape — the definition now lives in the zero-dep leaf
 * package `@appstrate/afps-shared`. Re-exported here so the public
 * `@appstrate/core/token-usage` import path stays stable for existing consumers.
 */
export type { TokenUsage } from "@appstrate/afps-shared/token-usage";
