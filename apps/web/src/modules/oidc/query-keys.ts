// SPDX-License-Identifier: Apache-2.0

/**
 * React Query key prefixes owned by the OIDC module UI. Picked up
 * automatically by `module-query-keys.ts` via Vite's `import.meta.glob`,
 * so removing this module from the web bundle drops the keys from
 * app-switch invalidation without any edit to core files.
 */
export default ["oauth-clients"] as const;
