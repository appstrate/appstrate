#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage } from "@appstrate/core/errors";
import { parseBefore, pendingRuntimeTools } from "./0053-migrate-runtime-tools.ts";
import { pendingFileReadReceipts } from "./0055-chat-file-read-receipts.ts";
import { describeDatabaseTarget, exitUnlessDatabaseNamed } from "./lib/database-target.ts";

/** Run with writers stopped, immediately before the service that applies 0106. */
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
  const stores = await pendingRuntimeTools(before);
  const receipts = await pendingFileReadReceipts();
  return [
    { check: "0052 · notifications to fold", pending: row!.pending },
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
