// SPDX-License-Identifier: Apache-2.0

/**
 * Ceiling of `GET /api/runs/{id}?wait=`, in seconds, below typical 60 s proxy idle timeouts.
 * Larger values are clamped, not rejected. A leaf, so the OpenAPI spec can interpolate it.
 */
export const MAX_WAIT_SECONDS = 55;
