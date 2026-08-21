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

```sh
DATABASE_URL=postgres://… bun scripts/check-index-drift.ts
```

Diffs the latest snapshot's declared indexes against `pg_indexes`. Exits 1 on a declared-but-absent
index; extra indexes in the database (primary-key and unique-constraint backing indexes) are
reported for information only.

## Dependencies

- `drizzle-orm` + `postgres` — ORM and PostgreSQL driver
- `better-auth` — Session-based authentication
- `@appstrate/env` — Environment configuration
- `@appstrate/emails` — Email templates for auth flows
