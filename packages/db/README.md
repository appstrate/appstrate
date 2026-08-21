# @appstrate/db

Database and authentication layer for the Appstrate platform.

## Exports

| Import                  | Description                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `@appstrate/db/schema`  | Drizzle ORM schema (34 tables, 5 enums)                                                    |
| `@appstrate/db/client`  | `db` instance + `listenClient` for PostgreSQL LISTEN/NOTIFY                                |
| `@appstrate/db/auth`    | Better Auth config (email/password, Google/GitHub social, email verification, magic links) |
| `@appstrate/db/storage` | S3 storage integration                                                                     |
| `@appstrate/db/notify`  | PostgreSQL notification helpers                                                            |

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

## Index drift

`drizzle/0000_init.sql` is a squash, and any database created before it — production — never ran
it. An index the squash introduced therefore exists in the schema and in every fresh database while
being absent there (issue #1182 found two). Before any `DROP INDEX`, verify the surviving index
against the **live** database; the TS schema and `0000_init.sql` are not evidence.

Run from the **repo root**, not from this directory:

```sh
cd ../.. && DATABASE_URL=postgres://… bun scripts/check-index-drift.ts
```

It reads the database's own migration watermark (`max(created_at)` in
`drizzle.__drizzle_migrations`) and diffs against the snapshot matching it — not the newest snapshot
on disk — so a database that has not yet run a pending release is not accused of missing every index
that release adds. Pending migrations are named in the output. Exit 1 means either a declared index
is absent, or the check could not run (unmigrated database, or a watermark matching no journal
entry); every refusal says `Cannot check`, so it can never read as a clean result.

Indexes present in the database but absent from the snapshot never fail the run. Those a constraint
owns (`pg_constraint.conindid`) are counted as expected; the rest are listed by name as possible
reverse drift — an index a squash may have dropped from the schema without a forward `DROP INDEX`.

## Dependencies

- `drizzle-orm` + `postgres` — ORM and PostgreSQL driver
- `better-auth` — Session-based authentication
- `@appstrate/env` — Environment configuration
- `@appstrate/emails` — Email templates for auth flows
