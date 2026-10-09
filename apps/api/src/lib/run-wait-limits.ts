// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side ceiling of `GET /api/runs/{id}?wait=`, in seconds. Kept below
 * typical proxy idle timeouts (commonly 60 s) — see `services/run-wait.ts`.
 * Values above the cap are clamped rather than rejected so clients can pass a
 * generous number and let the server decide (same convention as long-poll
 * `timeout` params in e.g. the Kubernetes watch API). A leaf: the OpenAPI spec
 * interpolates it without importing the wait service.
 */
export const MAX_WAIT_SECONDS = 55;
