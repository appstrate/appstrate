#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0030 — delete the org models Pi's registry does not offer (#1549).
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0030-pi-catalog-org-models.ts [--apply]
 *
 * Run INSIDE the deploy window (the scheduler reloads a schedule's model
 * override from the table only at boot), from the RELEASE checkout with the
 * platform env loaded (`DATABASE_URL`, `MODULES`, `SYSTEM_PROVIDER_KEYS`).
 * Dry run by default: one transaction, rolled back; `--apply` commits it after
 * writing `./0030-backup-<timestamp>.json` (deleted rows in full, every pointer
 * changed, before/after).
 *
 * For every `org_models` row outside its provider's offer (`registryOffers`,
 * the boot's own gate): an org default naming it moves to an enabled row of the
 * same credential (the provider's first featured id present, else the oldest),
 * else NULL — reported; a space pin or schedule override naming it goes to NULL
 * (the org default); then the row is deleted. A row of a provider `MODULES`
 * does not register is left alone. `--apply` refuses to run while
 * `verify-system-models` would fail. Every write is guarded on the value read,
 * and an after-check aborts unless nothing is left to do. Measured read-only on
 * production 2026-09-24: 6 rows — codex `gpt-5.4`, `gpt-5.4-mini`,
 * `gpt-5.4-nano`; deepseek `deepseek-chat`, `deepseek-reasoner`,
 * `deepseek-v4-flash`.
 */

import { parseArgs } from "node:util";
import { closeDb, db, isEmbeddedDb, toRows } from "@appstrate/db/client";
import { getErrorMessage } from "@appstrate/core/errors";
import { getEnv } from "../../packages/env/src/index.ts";
import { getModelProvider } from "../../apps/api/src/services/model-providers/registry.ts";
import {
  checkSystemModels,
  describeSystemModel,
  registerModuleModelProviders,
  registryOffers,
  type Offers,
} from "../verify-system-models.ts";

// ─── Plan (pure) ──────────────────────────────────────────

export interface OrgModelRow {
  id: string;
  orgId: string;
  credentialId: string;
  providerId: string;
  modelId: string;
  enabled: boolean;
}

export interface PiCatalogSnapshot {
  /** Oldest first. */
  orgModels: OrgModelRow[];
  orgDefaults: { orgId: string; modelId: string }[];
  spacePins: { spaceId: string; packageId: string; modelId: string }[];
  scheduleOverrides: { scheduleId: string; modelId: string }[];
}

export interface CatalogView {
  offers: Offers;
  featured(providerId: string): readonly string[];
}

export interface PiCatalogPlan {
  deletions: OrgModelRow[];
  unregistered: OrgModelRow[];
  orgDefaults: { orgId: string; from: string; to: string | null }[];
  clearedSpacePins: { spaceId: string; packageId: string; from: string }[];
  clearedScheduleOverrides: { scheduleId: string; from: string }[];
}

export function planPiCatalogMigration(
  snapshot: PiCatalogSnapshot,
  catalog: CatalogView,
): PiCatalogPlan {
  const offered = (r: OrgModelRow) => catalog.offers(r.providerId, r.modelId);
  const deletions = snapshot.orgModels.filter((r) => offered(r) === false);
  const gone = new Map(deletions.map((r) => [r.id, r]));
  const survivors = snapshot.orgModels.filter((r) => !gone.has(r.id));

  const repoint = (deleted: OrgModelRow): string | null => {
    const candidates = survivors.filter(
      (r) => r.orgId === deleted.orgId && r.credentialId === deleted.credentialId && r.enabled,
    );
    const featured = catalog
      .featured(deleted.providerId)
      .map((id) => candidates.find((r) => r.modelId === id))
      .find((r) => r !== undefined);
    return (featured ?? candidates[0])?.id ?? null;
  };

  return {
    deletions,
    unregistered: snapshot.orgModels.filter((r) => offered(r) === null),
    orgDefaults: snapshot.orgDefaults.flatMap(({ orgId, modelId }) => {
      const deleted = gone.get(modelId);
      return deleted ? [{ orgId, from: modelId, to: repoint(deleted) }] : [];
    }),
    clearedSpacePins: snapshot.spacePins.flatMap(({ spaceId, packageId, modelId }) =>
      gone.has(modelId) ? [{ spaceId, packageId, from: modelId }] : [],
    ),
    clearedScheduleOverrides: snapshot.scheduleOverrides.flatMap(({ scheduleId, modelId }) =>
      gone.has(modelId) ? [{ scheduleId, from: modelId }] : [],
    ),
  };
}

/** Pointers still naming any of `ids`. */
function countReferences(snapshot: PiCatalogSnapshot, ids: ReadonlySet<string>): number {
  return [...snapshot.orgDefaults, ...snapshot.spacePins, ...snapshot.scheduleOverrides].filter(
    (p) => ids.has(p.modelId),
  ).length;
}

// ─── Database ─────────────────────────────────────────────

export function registryCatalog(): CatalogView {
  return {
    offers: registryOffers,
    featured: (providerId) => getModelProvider(providerId)?.featuredModels ?? [],
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function query<T>(tx: Tx, statement: string): Promise<T[]> {
  return toRows<T>(await tx.execute(statement));
}

async function readSnapshot(tx: Tx): Promise<PiCatalogSnapshot> {
  return {
    orgModels: await query<OrgModelRow>(
      tx,
      `SELECT m.id::text AS "id", m.org_id::text AS "orgId", m.credential_id::text AS "credentialId",
              c.provider_id AS "providerId", m.model_id AS "modelId", m.enabled
         FROM org_models m JOIN model_provider_credentials c ON c.id = m.credential_id
        ORDER BY m.created_at, m.id`,
    ),
    orgDefaults: await query<PiCatalogSnapshot["orgDefaults"][number]>(
      tx,
      `SELECT id::text AS "orgId", default_model_id AS "modelId" FROM organizations
        WHERE default_model_id IS NOT NULL ORDER BY id`,
    ),
    spacePins: await query<PiCatalogSnapshot["spacePins"][number]>(
      tx,
      `SELECT space_id AS "spaceId", package_id AS "packageId", model_id AS "modelId"
         FROM space_packages WHERE model_id IS NOT NULL ORDER BY space_id, package_id`,
    ),
    scheduleOverrides: await query<PiCatalogSnapshot["scheduleOverrides"][number]>(
      tx,
      `SELECT id AS "scheduleId", model_id_override AS "modelId" FROM package_schedules
        WHERE model_id_override IS NOT NULL ORDER BY id`,
    ),
  };
}

/** A jsonb literal, dollar-quoted so nothing inside it is interpreted. */
function jsonb(value: unknown): string {
  const text = JSON.stringify(value);
  if (text.includes("$m0030$")) throw new Error("payload contains the quote tag");
  return `$m0030$${text}$m0030$::jsonb`;
}

/** Runs `statement` over `rows` and fails unless every row matched its guard. */
async function guardedWrite<T>(
  tx: Tx,
  what: string,
  rows: unknown[],
  statement: (payload: string) => string,
): Promise<T[]> {
  if (rows.length === 0) return [];
  const written = await query<T>(tx, statement(jsonb(rows)));
  if (written.length !== rows.length) {
    throw new Error(`${rows.length - written.length} ${what} changed since read — re-run`);
  }
  return written;
}

/** Every write is guarded on the value read: a concurrent edit aborts the run. */
export async function writePlan(tx: Tx, plan: PiCatalogPlan) {
  await guardedWrite(
    tx,
    "org default(s)",
    plan.orgDefaults,
    (p) =>
      `UPDATE organizations t SET default_model_id = v."to", updated_at = now()
         FROM jsonb_to_recordset(${p}) AS v("orgId" text, "from" text, "to" text)
        WHERE t.id::text = v."orgId" AND t.default_model_id = v."from"
       RETURNING 1`,
  );
  await guardedWrite(
    tx,
    "space pin(s)",
    plan.clearedSpacePins,
    (p) =>
      `UPDATE space_packages t SET model_id = NULL, updated_at = now()
         FROM jsonb_to_recordset(${p}) AS v("spaceId" text, "packageId" text, "from" text)
        WHERE t.space_id = v."spaceId" AND t.package_id = v."packageId" AND t.model_id = v."from"
       RETURNING 1`,
  );
  await guardedWrite(
    tx,
    "schedule override(s)",
    plan.clearedScheduleOverrides,
    (p) =>
      `UPDATE package_schedules t SET model_id_override = NULL, updated_at = now()
         FROM jsonb_to_recordset(${p}) AS v("scheduleId" text, "from" text)
        WHERE t.id = v."scheduleId" AND t.model_id_override = v."from"
       RETURNING 1`,
  );
  const deleted = await guardedWrite<{ row: Record<string, unknown> }>(
    tx,
    "org model(s)",
    plan.deletions.map(({ id, modelId }) => ({ id, modelId })),
    (p) =>
      `DELETE FROM org_models t USING jsonb_to_recordset(${p}) AS v(id text, "modelId" text)
        WHERE t.id::text = v.id AND t.model_id = v."modelId"
       RETURNING to_jsonb(t) AS row`,
  );
  return {
    org_models: deleted.map((d) => d.row),
    organizations: plan.orgDefaults.map((c) => ({
      id: c.orgId,
      default_model_id: { before: c.from, after: c.to },
    })),
    space_packages: plan.clearedSpacePins.map((c) => ({
      space_id: c.spaceId,
      package_id: c.packageId,
      model_id: { before: c.from, after: null },
    })),
    package_schedules: plan.clearedScheduleOverrides.map((c) => ({
      id: c.scheduleId,
      model_id_override: { before: c.from, after: null },
    })),
  };
}

function printPlan(plan: PiCatalogPlan, out: (line: string) => void): void {
  const where = (r: OrgModelRow) =>
    `org_models ${r.id} (org ${r.orgId}, ${r.providerId}/${r.modelId})`;
  for (const c of plan.orgDefaults) {
    const to = c.to ?? "NULL (falls to the system default, possibly platform-billed)";
    out(`  organizations ${c.orgId}: default_model_id → ${to}`);
  }
  for (const k of plan.clearedSpacePins) {
    out(`  space_packages ${k.spaceId} ${k.packageId}: model_id → NULL`);
  }
  for (const k of plan.clearedScheduleOverrides) {
    out(`  package_schedules ${k.scheduleId}: model_id_override → NULL`);
  }
  for (const r of plan.deletions) out(`  DELETE ${where(r)}`);
  out(`left alone — provider not registered by MODULES: ${plan.unregistered.length}`);
  for (const r of plan.unregistered) out(`  ${where(r)}`);
}

class DryRunRollback extends Error {}

export async function runPiCatalogMigration(options: {
  apply: boolean;
  catalog: CatalogView;
  systemKeys: readonly unknown[];
  backupPath: string;
  out: (line: string) => void;
}): Promise<PiCatalogPlan> {
  const { apply, catalog, systemKeys, backupPath, out } = options;
  const { outside } = checkSystemModels(systemKeys, catalog.offers);
  out(`SYSTEM_PROVIDER_KEYS models outside the offer (blocks --apply): ${outside.length}`);
  for (const m of outside) out(`  ${describeSystemModel(m)}`);
  if (apply && outside.length > 0) {
    throw new Error(`fix SYSTEM_PROVIDER_KEYS first — see scripts/verify-system-models.ts`);
  }

  let plan: PiCatalogPlan | undefined;
  let backupWritten = false;
  try {
    await db.transaction(async (tx) => {
      await tx.execute("SET LOCAL lock_timeout = '3s'");
      await tx.execute("SET LOCAL statement_timeout = '60s'");
      const before = await readSnapshot(tx);
      plan = planPiCatalogMigration(before, catalog);
      printPlan(plan, out);
      const backup = await writePlan(tx, plan);

      const gone = new Set(plan.deletions.map((r) => r.id));
      const after = await readSnapshot(tx);
      const left = planPiCatalogMigration(after, catalog).deletions.length;
      const refs = countReferences(after, gone);
      out(
        `out-of-offer org_models: before ${plan.deletions.length}, after ${left}; references to them: before ${countReferences(before, gone)}, after ${refs}`,
      );
      if (left + refs > 0) throw new Error("after-check failed — something is left; rolled back");

      const changes =
        backup.organizations.length +
        backup.space_packages.length +
        backup.package_schedules.length;
      const summary = `${backup.org_models.length} org_models row(s), ${changes} pointer change(s)`;
      if (!apply) {
        out(`backup: would write ${backupPath}: ${summary}`);
        throw new DryRunRollback();
      }
      if (backup.org_models.length + changes === 0)
        return out("backup: nothing changed, none written");
      // Written before COMMIT so a committed change always has its backup.
      await Bun.write(backupPath, `${JSON.stringify(backup, null, 2)}\n`);
      backupWritten = true;
      out(`backup: wrote ${backupPath}: ${summary}`);
    });
    out("0030: APPLIED — committed.");
  } catch (error) {
    if (!(error instanceof DryRunRollback)) {
      if (backupWritten) out(`backup: ${backupPath} was NOT committed — discard it`);
      throw error;
    }
    out("0030: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.");
  }
  return plan!;
}

// ─── Entry point ──────────────────────────────────────────

function databaseLabel(): string {
  if (isEmbeddedDb) return `embedded PGlite at ${getEnv().PGLITE_DATA_DIR}`;
  const url = new URL(getEnv().DATABASE_URL!);
  return `PostgreSQL ${url.hostname}:${url.port || "5432"}${url.pathname}`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { apply: { type: "boolean" } },
    strict: true,
  });
  const apply = values.apply === true;
  const out = (line: string) => process.stdout.write(`${line}\n`);
  const providers = await registerModuleModelProviders();
  out(`0030 — ${apply ? "APPLY" : "DRY RUN"} against ${databaseLabel()}`);
  out(`providers registered from MODULES: ${providers.join(", ")}`);
  await runPiCatalogMigration({
    apply,
    catalog: registryCatalog(),
    systemKeys: getEnv().SYSTEM_PROVIDER_KEYS as unknown[],
    backupPath: `${process.cwd()}/0030-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    out,
  });
}

if (import.meta.main) {
  let code = 1;
  try {
    await main();
    code = 0;
  } catch (error) {
    process.stdout.write(`0030: FAILED, nothing committed — ${getErrorMessage(error)}\n`);
  } finally {
    await closeDb();
  }
  process.exit(code);
}
