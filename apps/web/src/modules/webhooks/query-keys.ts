// SPDX-License-Identifier: Apache-2.0

/**
 * React Query key prefixes owned by the webhooks UI. Picked up automatically
 * by the `module-query-keys.ts` registry via Vite's `import.meta.glob`, so
 * deleting this directory removes the keys from the app-switch invalidation
 * set without any edit to core files.
 */
export default ["webhooks"] as const;
