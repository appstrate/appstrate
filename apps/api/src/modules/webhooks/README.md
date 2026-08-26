# Webhooks Module

Standard Webhooks delivery for run lifecycle events.

## Purpose

Lets spaces subscribe to run status changes (`run.started`, `run.success`, `run.failed`, `run.timeout`, `run.cancelled`) and receive signed HTTP callbacks. Implements the Standard Webhooks specification (HMAC-SHA256 signing, secret rotation, 8-attempt exponential backoff, delivery history).

## Tables it reads and writes

| Table                | Purpose                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `webhooks`           | Subscription rows (URL, event list, secret, optional package filter, payload mode, enabled flag, org + space). |
| `webhook_deliveries` | One row per delivery attempt with status code, latency, error, attempt count.                                  |

Both tables live in the **core** schema (`packages/db/src/schema/webhooks.ts`) and migrate with core — this module has no `schema.ts` and owns no tables, per the module contract in `../README.md`. Their FKs are declared there via Drizzle `.references()`. On space delete, webhooks cascade; on package delete, the scoped filter is set to null.

## Feature flags contributed

```ts
features: {
  webhooks: true;
}
```

## Space-scoping

Webhooks routes are not registered in core's `SPACE_SCOPED_PREFIXES`. Each route
validates the `spaceId` body/query field directly against the caller's
org (`assertSpaceBelongsToOrg` in `routes.ts`) rather than relying on the
`X-Space-Id` space-context middleware.

## Permissions

| Role  | Permissions                                          |
| ----- | ---------------------------------------------------- |
| owner | `webhooks:read`, `webhooks:write`, `webhooks:delete` |
| admin | `webhooks:read`, `webhooks:write`, `webhooks:delete` |

API key scopes: `webhooks:read`, `webhooks:write`, `webhooks:delete`.

Members and viewers have no access — webhooks are considered developer tooling and live under the admin-only surface.

## Events listened to

- `onRunStatusChange` — broadcast from core on every run lifecycle transition. The handler dispatches delivery jobs to the BullMQ webhook queue for every subscription whose event list includes the new status and whose optional package filter matches. Delivery is asynchronous and isolated per subscription.

## Workers & background activity

- BullMQ `webhook-delivery` worker. Processes delivery jobs, builds the Standard Webhooks envelope, signs it with the subscription's secret, POSTs to the subscriber URL, records the attempt, and schedules retries with exponential backoff (8 attempts total). SSRF protection runs on every delivery URL.

## Disable behavior

Remove `webhooks` from `MODULES`:

- `/api/webhooks` and sub-routes → 404.
- `onRunStatusChange` is still emitted by core, but with no listener attached it is a no-op.
- No BullMQ delivery worker.
- Existing `webhooks` and `webhook_deliveries` rows stay in the database, untouched and unused.
- Frontend: the `features.webhooks` flag is `false`, so the webhook pages and sidebar links are not rendered.
