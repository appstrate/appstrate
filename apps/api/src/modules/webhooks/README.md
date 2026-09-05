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

Two resources, one per scoping level — an org-level webhook fires for every
space in the org, so it is not the same grant as administering one space's
subscriptions.

| Resource       | Level | Granted to                 |
| -------------- | ----- | -------------------------- |
| `webhooks`     | space | presets `admin`, `builder` |
| `org-webhooks` | org   | org roles `owner`, `admin` |

Both carry `read`, `write`, `delete`, and both are API-key-grantable.

Every route picks its resource from the webhook's own level: the `level` field
of the create body, the stored row's `level` everywhere else. `GET
/api/webhooks` spans both levels and drops the rows whose level the caller
cannot read.

`operator` and `viewer` have no access — webhooks are developer tooling and
live under the governance surface.

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
