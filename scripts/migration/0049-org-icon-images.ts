#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0049 — organization icons left pointing at an image in object storage, cleared with their bytes:
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0049-org-icon-images.ts [--apply]
 *
 * Drizzle `0097` stored an uploaded organization logo as `image:<version>`, its bytes in the `orgs`
 * bucket; `0100` renames the column `icon`, whose grammar holds an image inline
 * (`data:image/webp;base64,…` or `data:image/png;base64,…`), and the platform reads neither the
 * pointer nor the bucket any more. Only a database that applied `0097` before `0100` holds such a
 * row; production never had the column.
 *
 * Run in the same window as `0100`, right after it (it refuses before): a leftover `image:<uuid>` has
 * the shape of an Iconify id, which every viewer would fetch from `api.iconify.design`. With `--apply`, every `icon` reading
 * `image:<version>` is set to NULL (the organization renders its initial), `updated_at` bumped, in
 * one transaction; then every object of the `orgs` bucket is deleted. Dry run by default: prints
 * the counts, writes nothing. With `--apply`, the rows and objects left must both be 0, else it
 * exits 1. Idempotent: a second run finds nothing, and one that failed between the commit and the
 * last delete deletes what is left. Targets `DATABASE_URL` or `PGLITE_DATA_DIR`, exits 2 with
 * neither (`lib/database-target.ts`); the bucket is the platform's storage (`S3_BUCKET`, else
 * `FS_STORAGE_PATH`), so load the platform's env.
 */

import { parseArgs } from "node:util";
import { like, sql } from "drizzle-orm";
import { organizations } from "@appstrate/db/schema";
import { deleteFile, listObjects } from "@appstrate/db/storage";
import { getErrorMessage } from "@appstrate/core/errors";
import { exitUnlessDatabaseNamed } from "./lib/database-target.ts";

/** The bucket `0097`'s image logos were kept in. */
const BUCKET = "orgs";
/** The legacy pointer: an image kept in {@link BUCKET}. */
const IMAGE_POINTER = like(organizations.icon, "image:%");

async function bucketKeys(): Promise<string[]> {
  const keys: string[] = [];
  for await (const object of listObjects(BUCKET)) keys.push(object.key);
  return keys;
}

export async function runOrgIconImages(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<void> {
  const { apply, out } = options;
  // Imported here: `@appstrate/db/client` opens its database on import, after the entry point's guard.
  const { db, toRows } = await import("@appstrate/db/client");
  const [target] = toRows<{ name: string; addr: string | null; port: number | null }>(
    await db.execute(
      "SELECT current_database() AS name, inet_server_addr()::text AS addr, inet_server_port() AS port",
    ),
  );
  out(`database: ${target!.name} at ${target!.addr ?? "local socket"}:${target!.port ?? "-"}`);

  const [column] = toRows<{ present: boolean }>(
    await db.execute(
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'organizations' AND column_name = 'icon') AS present",
    ),
  );
  if (!column?.present) throw new Error("organizations.icon is missing — apply drizzle 0100 first");

  const imagePointers = () =>
    db.select({ id: organizations.id }).from(organizations).where(IMAGE_POINTER);
  const pointers = await imagePointers();
  const keys = await bucketKeys();
  out(`organizations with an image icon: ${pointers.length}`);
  out(`objects in the ${BUCKET} bucket: ${keys.length}`);
  if (!apply) {
    out("0049: DRY RUN — nothing written. Re-run with --apply to commit.");
    return;
  }

  const cleared = await db.transaction(async (tx) => {
    await tx.execute("SET LOCAL lock_timeout = '5s'");
    await tx.execute("SET LOCAL statement_timeout = '60s'");
    return tx
      .update(organizations)
      .set({ icon: null, updatedAt: sql`now()` })
      .where(IMAGE_POINTER)
      .returning({ id: organizations.id });
  });
  for (const { id } of cleared) out(`  cleared org ${id}`);
  for (const key of keys) await deleteFile(BUCKET, key);
  out(`cleared: ${cleared.length}, deleted: ${keys.length}`);

  const rowsLeft = (await imagePointers()).length;
  const objectsLeft = (await bucketKeys()).length;
  out(`left: ${rowsLeft} organizations, ${objectsLeft} objects`);
  if (rowsLeft !== 0 || objectsLeft !== 0) throw new Error("image icons are left after --apply");
  out("0049: APPLIED — committed.");
}

if (import.meta.main) {
  exitUnlessDatabaseNamed();
  let code = 1;
  let closeDb: (() => Promise<void>) | undefined;
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { apply: { type: "boolean" } },
      strict: true,
    });
    const apply = values.apply === true;
    ({ closeDb } = await import("@appstrate/db/client"));
    const out = (line: string) => process.stdout.write(`${line}\n`);
    out(`0049 — ${apply ? "APPLY" : "DRY RUN"}`);
    await runOrgIconImages({ apply, out });
    code = 0;
  } catch (error) {
    process.stdout.write(
      `0049: FAILED — ${getErrorMessage(error)}. The row update is one transaction; a re-run with --apply finishes what is left.\n`,
    );
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
