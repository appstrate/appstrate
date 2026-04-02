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

## Dependencies

- `drizzle-orm` + `postgres` — ORM and PostgreSQL driver
- `better-auth` — Session-based authentication
- `@appstrate/env` — Environment configuration
- `@appstrate/emails` — Email templates for auth flows
