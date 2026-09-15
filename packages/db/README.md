# @appstrate/db

Database and authentication layer for the Appstrate platform.

## Exports

Every `exports` subpath of the package, in manifest order:

| Import                         | Description                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `@appstrate/db/schema`         | Drizzle ORM schema (51 tables, 9 enums)                                                    |
| `@appstrate/db/run-status`     | Import-free run-status literals + the terminal/active sets derived from them               |
| `@appstrate/db/pricing-status` | Import-free `pricing_status` literals (`priced` / `partial` / `unpriced`)                  |
| `@appstrate/db/client`         | `db` instance + `listenClient` for PostgreSQL LISTEN/NOTIFY                                |
| `@appstrate/db/auth`           | Better Auth config (email/password, Google/GitHub social, email verification, magic links) |
| `@appstrate/db/auth-policy`    | Pure `AUTH_*`-driven signup/platform-admin policy helpers (no DB access)                   |
| `@appstrate/db/bootstrap-org`  | Idempotent root-organization creation for `AUTH_BOOTSTRAP_OWNER_EMAIL`                     |
| `@appstrate/db/storage`        | S3 storage integration                                                                     |
| `@appstrate/db/notify`         | PostgreSQL notification helpers                                                            |

## Usage

```typescript
import { db } from "@appstrate/db/client";
import { packages, runs } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";

const rows = await db.select().from(packages).where(eq(packages.orgId, orgId));
```

## Migrations

```sh
bun run db:generate   # Generate migration from schema changes
bun run db:migrate    # Apply pending migrations
```

## Schema drift

`drizzle/0000_init.sql` is a squash, and any database created before it — production — never ran
it. Anything the squash introduced therefore exists in the schema and in every fresh database while
being absent there (issue #1182 found two indexes). Before any `DROP INDEX`, verify the surviving
index against the **live** database; the TS schema and `0000_init.sql` are not evidence.

```sh
DATABASE_URL=postgres://… bun scripts/check-index-drift.ts
```

`DATABASE_URL` is the only input — no other variable is read, so the check runs from a jump host that
holds nothing but a production connection string. Paths come from the script's own location, so the
working directory does not matter either. Bun does auto-load a `.env` from the working directory, so
pass `DATABASE_URL` inline as above rather than relying on the environment: run from the repo root
without it and you would silently check your own dev database.

It reads the database's own migration watermark (`max(created_at)` in
`drizzle.__drizzle_migrations`) and diffs against the snapshot matching it — not the newest snapshot
on disk — so a database that has not yet run a pending release is not accused of missing everything
that release adds. Pending migrations are named in the output. Exit 1 means either something
declared is absent, or the check declined to run (unmigrated database, empty tracking table, or a
watermark matching no journal entry); each of those opens with `Cannot check`, so it can never read
as a clean result. A connection or authentication failure surfaces the driver error instead.

Two populations are compared, and both halves are reported before the exit code is decided — an
operator missing an index _and_ a column sees both in one run.

**Indexes** are compared by **name only**. An index present under the expected name with a different
definition — other columns, a lost partial predicate, lost uniqueness — counts as present, and the
success line says so. A squash can redefine an index while a pre-squash database keeps the old shape
under the same name; catching that is out of scope here.

**Columns** are compared by name and by `NOT NULL`; their **types** are not compared, because the
normalisation that would make a type comparison honest is where the false positives live. A missing
column is louder than a missing index — a Postgres `42703` on the first statement naming it — and
nothing else in the repo can see it on a live database (issue #1349). The Better Auth drizzle
adapter looks like it does and does not: `findDrizzleSchemaProblems` diffs the plugin's expectations
against the **Drizzle TS object**, never against `information_schema`, so a database missing a
declared column boots perfectly clean. `apps/api/test/unit/migration-schema-parity.test.ts` covers
the other link of that chain in CI by replaying the journal into a throwaway PGlite — but a replay
structurally cannot see a database that never ran the squash.

Indexes and columns present in the database but absent from the snapshot never fail the run. Indexes
a constraint owns (`pg_constraint.conindid`) are counted as expected; the rest are listed by name as
possible reverse drift — something a squash may have dropped from the schema without a forward
`DROP INDEX` / `DROP COLUMN`.

Nothing here runs at boot, deliberately: production is known to predate `0000_init.sql`, so a
boot-time gate on the same comparison would refuse to start the platform over drift that has been
live for months. The exit code is a decision a human makes.

## Dependencies

- `drizzle-orm` + `postgres` — ORM and PostgreSQL driver
- `better-auth` — Session-based authentication
- `@appstrate/env` — Environment configuration
- `@appstrate/emails` — Email templates for auth flows
