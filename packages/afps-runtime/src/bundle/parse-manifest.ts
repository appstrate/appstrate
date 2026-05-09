// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Shared helper for parsing manifest.json bytes inside an AFPS bundle.
 *
 * Three call sites used to inline this exact decode + JSON.parse + object
 * shape check (build.ts, read.ts, and apps/api's manifest-parser.ts). The
 * runtime variant raises a `BundleError("BUNDLE_JSON_INVALID")` with the
 * caller-supplied `identity` (used in `read.ts` to attribute the failure
 * to a specific nested package); apps/api uses its own ApiError flavor and
 * therefore keeps its own thin wrapper.
 */

import { BundleError } from "./errors.ts";

export interface ParseManifestOptions {
  /** Optional package identity (e.g. `@scope/name@1.2.3`) attached to the error message + details. */
  identity?: string;
}

/**
 * Decode `bytes` as UTF-8 and JSON-parse it; assert the result is a plain
 * object (not array, not null). Throws a `BundleError("BUNDLE_JSON_INVALID")`
 * on any failure with a uniform message shape.
 */
export function parseAfpsManifestBytes(
  bytes: Uint8Array,
  options: ParseManifestOptions = {},
): Record<string, unknown> {
  const { identity } = options;
  const prefix = identity ? `manifest.json for ${identity}` : "manifest.json";
  const details = identity ? { identity } : undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw new BundleError(
      "BUNDLE_JSON_INVALID",
      `${prefix} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      details,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BundleError("BUNDLE_JSON_INVALID", `${prefix} must be a JSON object`, details);
  }
  return parsed as Record<string, unknown>;
}
