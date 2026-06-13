// SPDX-License-Identifier: Apache-2.0

/**
 * React Query key prefixes owned by the OIDC module UI that must be wiped on
 * application switch. Picked up automatically by `module-query-keys.ts` via
 * Vite's `import.meta.glob`.
 *
 * Empty since the typed-client migration: `/api/oauth/clients` is org-scoped
 * (the server returns every app's clients for the org, identical across app
 * switches), and the SMTP/social-provider queries carry the application id
 * inside their `[method, path, init]` key, so they self-scope without any
 * reset. Org switch is handled globally (all non-`["orgs"]` queries removed).
 */
export default [] as const;
