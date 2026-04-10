# Provider Management Module

Org-level LLM provider keys and model catalog.

## Purpose

Extends Appstrate's built-in system models (configured via the `SYSTEM_PROVIDER_KEYS` environment variable) with per-organization provider keys and model definitions. When loaded, organizations can bring their own Anthropic / OpenAI / OpenRouter / custom API keys and expose them as selectable models for their agents. Without the module, only system models are available.

## Owned tables

| Table               | Purpose                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `org_provider_keys` | One row per provider credential per org. API key is stored encrypted with `CONNECTION_ENCRYPTION_KEY`.      |
| `org_models`        | One row per model definition. Each row references a provider key and carries cost/context/pricing metadata. |

All FKs to core tables (`organizations`, `user`) and the intra-module `org_provider_keys → org_models` reference are declared via Drizzle `.references()` in `schema.ts`.

## Feature flags contributed

```ts
features: { models: true, providerKeys: true }
```

## Permissions

| Role   | Permissions                                                   |
| ------ | ------------------------------------------------------------- |
| owner  | `models:read/write/delete`, `provider-keys:read/write/delete` |
| admin  | `models:read/write/delete`, `provider-keys:read/write/delete` |
| member | `models:read`                                                 |
| viewer | `models:read`                                                 |

API key scopes: `models:read`, `models:write`, `models:delete`. Provider keys are intentionally session-only — API keys cannot create or manage credentials.

## Hooks implemented

- `resolveModel` (first-match) — called by the run pipeline to turn an optional model id into a `ResolvedModelResult` (api, baseUrl, modelId, apiKey, pricing, context window, …). Resolution cascade: explicit override → org default model → system default. When the module is absent, core falls back directly to `resolveSystemModel()` using the `SYSTEM_PROVIDER_KEYS` env var.

## Disable behavior

Remove `provider-management` from `APPSTRATE_MODULES`:

- `/api/models` and `/api/provider-keys` → 404.
- `resolveModel` hook is absent, so core falls back to `resolveSystemModel()` (system models only). Runs that reference an org model by id will fail with "Model not found".
- Existing `org_provider_keys` / `org_models` rows stay in the database, untouched and unused.
- Frontend: the `features.models` and `features.providerKeys` flags are `false`, so the settings pages and sidebar links are not rendered.
