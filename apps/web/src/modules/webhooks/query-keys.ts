// SPDX-License-Identifier: Apache-2.0

/**
 * React Query key prefixes owned by the webhooks UI that must be wiped on
 * application switch. Picked up automatically by `module-query-keys.ts` via
 * Vite's `import.meta.glob`.
 *
 * Empty since the typed-client migration: the webhook list keys carry the
 * `applicationId` query param inside their `[method, path, init]` key, and
 * detail/deliveries keys are addressed by globally-unique `wh_` ids, so all
 * webhook queries self-scope without any reset. Org switch is handled
 * globally (all non-`["orgs"]` queries removed).
 */
export default [] as const;
