#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage } from "@appstrate/core/errors";
import { parseBefore, pendingRuntimeTools } from "./0053-migrate-runtime-tools.ts";
import { pendingFileReadReceipts } from "./0055-chat-file-read-receipts.ts";
import { describeDatabaseTarget, exitUnlessDatabaseNamed } from "./lib/database-target.ts";

/** Run with writers stopped, immediately before the schema migration service. */
export async function checkBeforeSchema() {
  const { db, toRows } = await import("@appstrate/db/client");
  const checks = [];
  for (const [table, column] of [
    ["packages", "type"],
    ["package_version_dependencies", "dep_type"],
  ] as const) {
    const [relation] = toRows<{ present: boolean }>(
      await db.execute(`SELECT to_regclass('public.${table}') IS NOT NULL AS present`),
    );
    if (!relation!.present) continue;
    const [row] = toRows<{ pending: number }>(
      await db.execute(`SELECT count(*)::int AS pending FROM public.${table}
        WHERE ${column}::text = 'mcp-server'`),
    );
    checks.push({ check: `0054 · ${table}.${column}`, pending: row!.pending });
  }
  for (const table of ["run_reads", "oauth_grant_states"] as const) {
    const [relation] = toRows<{ present: boolean }>(
      await db.execute(`SELECT to_regclass('public.${table}') IS NOT NULL AS present`),
    );
    if (!relation!.present) continue;
    const [row] = toRows<{ pending: number }>(
      await db.execute(`SELECT count(*)::int AS pending FROM public.${table} r
        WHERE r.space_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.spaces s WHERE s.id = r.space_id AND s.org_id = r.org_id
        )`),
    );
    checks.push({
      check: `0113 · ${table} space belongs to another organization`,
      pending: row!.pending,
    });
  }
  return checks;
}

/** The original 0053 cutoff is part of the data migration's identity on this installation. */
export async function checkBeforeTraffic(before: Date) {
  const { db, toRows } = await import("@appstrate/db/client");
  const [row] = toRows<{ pending: number }>(
    await db.execute(
      "SELECT count(*)::int AS pending FROM notifications WHERE type = 'run_failed' " +
        "AND coalesce(payload ->> 'status', '') NOT IN ('failed', 'timeout')",
    ),
  );
  const [missingRead] = toRows<{ pending: number }>(
    await db.execute(`SELECT count(*)::int AS pending FROM notifications n
      WHERE n.type = 'run_failed' AND n.run_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM run_reads r WHERE r.run_id = n.run_id
        AND r.recipient_type = n.recipient_type AND r.recipient_id = n.recipient_id
      )`),
  );
  const stores = await pendingRuntimeTools(before);
  const receipts = await pendingFileReadReceipts();
  return [
    { check: "0052 · notifications to fold", pending: row!.pending },
    { check: "0052 · notifications missing recipient read state", pending: missingRead!.pending },
    ...stores.map(({ store, pending }) => ({ check: `0053 · ${store}`, pending })),
    { check: "0055 · messages to rewrite", pending: receipts.messages },
  ];
}

if (import.meta.main) {
  const [phase, ...args] = Bun.argv.slice(2);
  const before =
    phase === "before-traffic" && args.length === 2 && args[0] === "--before"
      ? parseBefore(args[1], Date.now())
      : undefined;
  if (!((phase === "before-schema" && args.length === 0) || (before && "before" in before))) {
    process.stderr.write(
      "usage: verify-beta68-upgrade.ts before-schema | before-traffic --before <original RFC 3339 cutoff>\n",
    );
    if (before && "refusal" in before) process.stderr.write(`${before.refusal}\n`);
    process.exit(2);
  }
  exitUnlessDatabaseNamed();
  const { closeDb } = await import("@appstrate/db/client");
  try {
    process.stdout.write(`${await describeDatabaseTarget()}\n`);
    const checks =
      before && "before" in before
        ? await checkBeforeTraffic(before.before)
        : await checkBeforeSchema();
    for (const { check, pending } of checks) process.stdout.write(`${check}: ${pending}\n`);
    if (checks.some(({ pending }) => pending > 0)) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Upgrade check failed: ${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
