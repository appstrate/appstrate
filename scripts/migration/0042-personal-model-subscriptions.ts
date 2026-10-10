#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0042 — model subscriptions become personal:
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0042-personal-model-subscriptions.ts [--apply]
 *
 * A subscription (an `oauth` model credential) serves only the member who connected it, so the
 * rows written before drizzle `0087` are re-homed: a subscription whose creator (`created_by`) is
 * still a member of its organization (`org_members`) becomes theirs (`owner_user_id`); one with no
 * creator, or whose creator has left the organization, is an orphan, deleted with its pairings.
 * Non-aliased organization models bound to any subscription are unbound (`credential_id` NULL, `provider_id`
 * kept), so each member now brings their own credential for them. Subscriptions are recognised by
 * decrypting the blob (`kind === "oauth"`), never through the provider registry: the subscription
 * modules are absent in production. A blob that does not decrypt is reported and left as it is.
 * A pending pairing that would reconnect a subscription for anyone but its new owner is deleted.
 * The members owning a subscription are locked first, in the order the organization exit takes
 * them, so a member leaving during the run either loses the credential or is already gone (orphan).
 * Run after the deploy, app up, with the `pg_dump` taken before it (`0087` runs at boot).
 * Refuses an empty `DATABASE_URL`. One transaction
 * per organization; dry run by default (each rolled back), `--apply` commits. Idempotent.
 * `--apply` refuses, and the organization rolls back, while an aliased model is still bound to one
 * of its subscriptions (an alias needs an organization credential) or while a `pending`/`running`
 * run is pinned to one, while a schedule overrides its model with a model it would unbind (a
 * schedule spends organization credentials only), or while two models it would unbind share a
 * provider and model id (one unbound row per pair). The organization default and the agents
 * pointing at an unbound model are reported: they keep serving members, and a schedule, API key
 * or end user using them is refused. It fails at the end while an unreadable org-owned blob is left.
 */

import { parseArgs } from "node:util";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  modelProviderCredentials as c,
  modelProviderPairings,
  organizationMembers,
  orgModels,
  organizations,
  runs,
  schedules,
  spacePackages,
  spaces,
  user,
} from "@appstrate/db/schema";
import { decryptCredentials } from "@appstrate/connect";
import { getErrorMessage } from "@appstrate/core/errors";
import { activeRunStatusValues } from "@appstrate/core/run-status";
import { decryptStoredCredential } from "../../apps/api/src/lib/stored-credential.ts";

class DryRunRollback extends Error {}

export interface OwnedSubscription {
  id: string;
  label: string;
  ownerUserId: string;
}

export interface OrphanSubscription {
  id: string;
  label: string;
}

export interface OrgSubscriptionReport {
  orgId: string;
  owned: OwnedSubscription[];
  orphans: OrphanSubscription[];
  pairingsDeleted: number;
  unboundModels: Array<{ id: string; label: string }>;
  /** Aliased models bound to a subscription: `--apply` refuses until they are rebound or deleted. */
  aliasedModels: Array<{ id: string; label: string }>;
  /** Pending or running runs pinned to a subscription: `--apply` refuses until they finish. */
  activeRuns: Array<{ id: string }>;
  /** Schedules overriding their model with one this script unbinds: `--apply` refuses. */
  scheduleOverrides: Array<{ id: string; modelId: string }>;
  /** Models to unbind that would repeat a `(provider, model)` pair already unbound: `--apply` refuses. */
  duplicateUnbound: Array<{ id: string; label: string }>;
  /** The organization default, when it names a model this script unbinds. */
  defaultModelUnbound: string | null;
  /** Agents (per space) whose model this script unbinds. */
  agentModels: Array<{ spaceId: string; packageId: string; modelId: string }>;
  /** Members whose runs used a subscription they do not own (orphans count as not owned). */
  usersOnOthersSubscriptions: Array<{ id: string; email: string }>;
}

export interface SubscriptionMigration {
  orgs: OrgSubscriptionReport[];
  unreadable: Array<{ id: string; orgId: string; label: string }>;
}

export async function runPersonalModelSubscriptions(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<SubscriptionMigration> {
  const { apply, out } = options;
  // Imported here: `@appstrate/db/client` opens its database on import, after the entry point's guard.
  const { db, toRows } = await import("@appstrate/db/client");
  const [target] = toRows<{ name: string; addr: string | null; port: number | null }>(
    await db.execute(
      "SELECT current_database() AS name, inet_server_addr()::text AS addr, inet_server_port() AS port",
    ),
  );
  out(`database: ${target!.name} at ${target!.addr ?? "local socket"}:${target!.port ?? "-"}`);

  /** Org-owned subscriptions by organization. Read-only; decrypts each org-owned blob once. */
  async function scanOrgOwnedSubscriptions() {
    const rows = await db
      .select({
        id: c.id,
        orgId: c.orgId,
        label: c.label,
        createdBy: c.createdBy,
        ciphertext: c.credentialsEncrypted,
      })
      .from(c)
      .where(isNull(c.ownerUserId));
    const subscriptions = new Map<string, Array<(typeof rows)[number]>>();
    const unreadable: SubscriptionMigration["unreadable"] = [];
    for (const row of rows) {
      const blob = decryptStoredCredential(
        () => decryptCredentials<{ kind?: unknown } | null>(row.ciphertext),
        { credentialId: row.id },
      );
      if (blob === null) {
        unreadable.push({ id: row.id, orgId: row.orgId, label: row.label });
        continue;
      }
      if (blob?.kind !== "oauth") continue;
      subscriptions.set(row.orgId, [...(subscriptions.get(row.orgId) ?? []), row]);
    }
    return { subscriptions, unreadable };
  }

  const scan = await scanOrgOwnedSubscriptions();
  const toMigrate = [...scan.subscriptions.values()].reduce((sum, rows) => sum + rows.length, 0);
  out(`to migrate: ${toMigrate}`);
  for (const { id, label } of scan.unreadable) {
    out(`unreadable, skipped (not deleted): ${id} ${JSON.stringify(label)}`);
  }

  const orgs: OrgSubscriptionReport[] = [];
  for (const orgId of [...scan.subscriptions.keys()].sort()) {
    const candidates = scan.subscriptions.get(orgId)!;
    const captured: { report?: OrgSubscriptionReport } = {};
    try {
      await db.transaction(async (tx) => {
        await tx.execute("SET LOCAL lock_timeout = '5s'");
        await tx.execute("SET LOCAL statement_timeout = '300s'");
        // The creators' memberships first, in the organization exit's order (member, then
        // credentials): a creator leaving now waits, or has left and reads as an orphan.
        const creators = [
          ...new Set(candidates.map((r) => r.createdBy).filter((id): id is string => id !== null)),
        ].sort();
        if (creators.length) {
          await tx
            .select({ userId: organizationMembers.userId })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                inArray(organizationMembers.userId, creators),
              ),
            )
            .orderBy(organizationMembers.userId)
            .for("update");
        }
        // Re-read under row locks: a subscription another writer re-homed since the scan is left alone.
        const live = await tx
          .select({
            id: c.id,
            label: c.label,
            createdBy: c.createdBy,
            creatorIsMember: organizationMembers.userId,
          })
          .from(c)
          .leftJoin(
            organizationMembers,
            and(
              eq(organizationMembers.orgId, c.orgId),
              eq(organizationMembers.userId, c.createdBy),
            ),
          )
          .where(
            and(
              eq(c.orgId, orgId),
              isNull(c.ownerUserId),
              inArray(
                c.id,
                candidates.map((r) => r.id),
              ),
            ),
          )
          .for("update", { of: c });
        const owned = live.filter((r) => r.creatorIsMember !== null);
        const orphans = live.filter((r) => r.creatorIsMember === null);
        const liveIds = live.map((r) => r.id);
        const orphanIds = orphans.map((r) => r.id);

        // Refusals: `--apply` throws (the organization rolls back); a dry run only reports them.
        const aliasedModels = liveIds.length
          ? await tx
              .select({ id: orgModels.id, label: orgModels.label })
              .from(orgModels)
              .where(
                and(
                  eq(orgModels.orgId, orgId),
                  eq(orgModels.aliased, true),
                  inArray(orgModels.credentialId, liveIds),
                ),
              )
          : [];
        const activeRuns = liveIds.length
          ? await tx
              .select({ id: runs.id })
              .from(runs)
              .where(
                and(
                  eq(runs.orgId, orgId),
                  inArray(runs.status, [...activeRunStatusValues]),
                  inArray(runs.modelCredentialId, liveIds),
                ),
              )
          : [];
        // The models this run unbinds, and what still points at them.
        const toUnbind = liveIds.length
          ? await tx
              .select({
                id: orgModels.id,
                label: orgModels.label,
                providerId: orgModels.providerId,
                modelId: orgModels.modelId,
              })
              .from(orgModels)
              .where(
                and(
                  eq(orgModels.orgId, orgId),
                  eq(orgModels.aliased, false),
                  inArray(orgModels.credentialId, liveIds),
                ),
              )
          : [];
        const toUnbindIds = toUnbind.map((m) => m.id);
        const alreadyUnbound = toUnbind.length
          ? await tx
              .select({ providerId: orgModels.providerId, modelId: orgModels.modelId })
              .from(orgModels)
              .where(and(eq(orgModels.orgId, orgId), isNull(orgModels.credentialId)))
          : [];
        const seen = new Set(alreadyUnbound.map((m) => `${m.providerId}\u0000${m.modelId}`));
        const duplicateUnbound: Array<{ id: string; label: string }> = [];
        for (const m of toUnbind) {
          const key = `${m.providerId}\u0000${m.modelId}`;
          if (seen.has(key)) duplicateUnbound.push({ id: m.id, label: m.label });
          seen.add(key);
        }
        const scheduleOverrides = toUnbindIds.length
          ? await tx
              .select({ id: schedules.id, modelId: schedules.modelIdOverride })
              .from(schedules)
              .where(
                and(eq(schedules.orgId, orgId), inArray(schedules.modelIdOverride, toUnbindIds)),
              )
              .then((rows) => rows.map((r) => ({ id: r.id, modelId: r.modelId! })))
          : [];
        const [org] = await tx
          .select({ defaultModelId: organizations.defaultModelId })
          .from(organizations)
          .where(eq(organizations.id, orgId));
        const defaultModelUnbound =
          org?.defaultModelId && toUnbindIds.includes(org.defaultModelId)
            ? org.defaultModelId
            : null;
        const agentModels = toUnbindIds.length
          ? await tx
              .select({
                spaceId: spacePackages.spaceId,
                packageId: spacePackages.packageId,
                modelId: spacePackages.modelId,
              })
              .from(spacePackages)
              .innerJoin(spaces, eq(spaces.id, spacePackages.spaceId))
              .where(and(eq(spaces.orgId, orgId), inArray(spacePackages.modelId, toUnbindIds)))
              .then((rows) => rows.map((r) => ({ ...r, modelId: r.modelId! })))
          : [];

        if (apply && scheduleOverrides.length) {
          const named = scheduleOverrides.map((r) => `${r.id} (model ${r.modelId})`).join(", ");
          throw new Error(
            `org ${orgId}: schedules override their model with a model this unbinds (a schedule spends organization credentials only), change their model: ${named}`,
          );
        }
        if (apply && duplicateUnbound.length) {
          const named = duplicateUnbound
            .map((m) => `${m.id} ${JSON.stringify(m.label)}`)
            .join(", ");
          throw new Error(
            `org ${orgId}: unbinding would repeat a provider and model already unbound, delete one of each pair: ${named}`,
          );
        }
        if (apply && aliasedModels.length) {
          const named = aliasedModels.map((m) => `${m.id} ${JSON.stringify(m.label)}`).join(", ");
          throw new Error(
            `org ${orgId}: aliased models still bound to a subscription, rebind or delete them: ${named}`,
          );
        }
        if (apply && activeRuns.length) {
          const ids = activeRuns.map((r) => r.id).join(", ");
          throw new Error(
            `org ${orgId}: runs still active on a subscription, wait for them: ${ids}`,
          );
        }

        // Before any delete: deleting a credential nulls `runs.model_credential_id`.
        const usersOnOthers = liveIds.length
          ? await tx
              .selectDistinct({ id: user.id, email: user.email })
              .from(runs)
              .innerJoin(c, eq(runs.modelCredentialId, c.id))
              .innerJoin(user, eq(user.id, runs.userId))
              .where(
                and(inArray(c.id, liveIds), sql`${runs.userId} IS DISTINCT FROM ${c.createdBy}`),
              )
              .orderBy(user.id)
          : [];

        if (owned.length) {
          await tx
            .update(c)
            .set({ ownerUserId: sql`${c.createdBy}` })
            .where(
              inArray(
                c.id,
                owned.map((r) => r.id),
              ),
            );
        }
        // Aliased rows are never unbound here: they refuse above. A dry run that
        // reports duplicates stops short of the update the unique index would refuse.
        const unboundModels =
          toUnbindIds.length && !duplicateUnbound.length
            ? await tx
                .update(orgModels)
                .set({ credentialId: null, updatedAt: sql`now()` })
                .where(inArray(orgModels.id, toUnbindIds))
                .returning({ id: orgModels.id, label: orgModels.label })
            : toUnbind.map(({ id, label }) => ({ id, label }));
        // Every pairing of an orphan, and any pairing that would reconnect a now
        // personal subscription for someone other than its owner (an owned row's
        // creator is a member, so never null).
        const pairingTargets = [
          ...(orphanIds.length
            ? [
                inArray(modelProviderPairings.credentialId, orphanIds),
                inArray(modelProviderPairings.reconnectCredentialId, orphanIds),
              ]
            : []),
          ...owned.map((r) =>
            and(
              eq(modelProviderPairings.reconnectCredentialId, r.id),
              ne(modelProviderPairings.userId, r.createdBy!),
            ),
          ),
        ];
        const pairings = pairingTargets.length
          ? await tx
              .delete(modelProviderPairings)
              .where(and(eq(modelProviderPairings.orgId, orgId), or(...pairingTargets)))
              .returning({ id: modelProviderPairings.id })
          : [];
        if (orphanIds.length) await tx.delete(c).where(inArray(c.id, orphanIds));

        captured.report = {
          orgId,
          owned: owned.map((r) => ({ id: r.id, label: r.label, ownerUserId: r.createdBy! })),
          orphans: orphans.map((r) => ({ id: r.id, label: r.label })),
          pairingsDeleted: pairings.length,
          unboundModels,
          aliasedModels,
          activeRuns,
          scheduleOverrides,
          duplicateUnbound,
          defaultModelUnbound,
          agentModels,
          usersOnOthersSubscriptions: usersOnOthers,
        };
        if (!apply) throw new DryRunRollback();
      });
    } catch (error) {
      if (!(error instanceof DryRunRollback)) throw error;
    }
    const done = captured.report;
    if (!done) continue;
    orgs.push(done);
    const verb = apply ? "deleted" : "to delete";
    out(
      `org ${orgId}: owned ${done.owned.length}, orphans ${done.orphans.length} (${verb}), pairings ${done.pairingsDeleted}, models unbound ${done.unboundModels.length}`,
    );
    for (const r of done.owned)
      out(`  owner ${r.id} ${JSON.stringify(r.label)} → ${r.ownerUserId}`);
    for (const r of done.orphans) out(`  orphan ${r.id} ${JSON.stringify(r.label)}`);
    for (const m of done.unboundModels) out(`  unbound model ${m.id} ${JSON.stringify(m.label)}`);
    for (const m of done.aliasedModels)
      out(`  aliased model ${m.id} ${JSON.stringify(m.label)} blocks --apply`);
    for (const r of done.activeRuns) out(`  active run ${r.id} blocks --apply`);
    for (const r of done.scheduleOverrides)
      out(`  schedule ${r.id} overrides its model with ${r.modelId}: blocks --apply`);
    for (const m of done.duplicateUnbound)
      out(
        `  model ${m.id} ${JSON.stringify(m.label)} would repeat an unbound pair: blocks --apply`,
      );
    if (done.defaultModelUnbound) {
      out(
        `  organization default ${done.defaultModelUnbound} becomes member-paid: schedules, API keys and end users using it are refused`,
      );
    }
    for (const a of done.agentModels)
      out(`  agent ${a.packageId} in space ${a.spaceId} runs on ${a.modelId}, now member-paid`);
    const others = done.usersOnOthersSubscriptions.map((u) => `${u.email} (${u.id})`);
    out(`  users on subscriptions they do not own: ${others.join(", ") || "none"}`);
  }

  const distinctUsers = new Map<string, string>();
  for (const org of orgs) {
    for (const u of org.usersOnOthersSubscriptions) distinctUsers.set(u.id, u.email);
  }
  out(
    `summary: owned ${orgs.reduce((n, o) => n + o.owned.length, 0)}, orphans ${orgs.reduce((n, o) => n + o.orphans.length, 0)}, pairings ${orgs.reduce((n, o) => n + o.pairingsDeleted, 0)}, models unbound ${orgs.reduce((n, o) => n + o.unboundModels.length, 0)}, aliased models blocking ${orgs.reduce((n, o) => n + o.aliasedModels.length, 0)}, active runs blocking ${orgs.reduce((n, o) => n + o.activeRuns.length, 0)}, schedule overrides blocking ${orgs.reduce((n, o) => n + o.scheduleOverrides.length, 0)}, duplicate unbound blocking ${orgs.reduce((n, o) => n + o.duplicateUnbound.length, 0)}, unreadable skipped ${scan.unreadable.length}, users on subscriptions they do not own ${distinctUsers.size}`,
  );

  if (!apply) {
    out("0042: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.");
    return { orgs, unreadable: scan.unreadable };
  }
  const left = await scanOrgOwnedSubscriptions();
  const leftCount = [...left.subscriptions.values()].reduce((sum, rows) => sum + rows.length, 0);
  out(`left to migrate: ${leftCount}`);
  if (leftCount !== 0) throw new Error("subscriptions are left org-owned");
  out(`left unreadable: ${left.unreadable.length}`);
  if (left.unreadable.length) {
    const named = left.unreadable.map((r) => `${r.id} ${JSON.stringify(r.label)}`).join(", ");
    throw new Error(
      `unreadable org-owned credentials left, repair or delete them, then re-run: ${named}`,
    );
  }
  out("0042: APPLIED — committed.");
  return { orgs, unreadable: scan.unreadable };
}

if (import.meta.main) {
  let code = 1;
  let closeDb: (() => Promise<void>) | undefined;
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { apply: { type: "boolean" } },
      strict: true,
    });
    const apply = values.apply === true;
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is empty — refusing the embedded ./data/pglite; load the .env");
    }
    ({ closeDb } = await import("@appstrate/db/client"));
    const out = (line: string) => process.stdout.write(`${line}\n`);
    out(`0042 — ${apply ? "APPLY" : "DRY RUN"}`);
    await runPersonalModelSubscriptions({ apply, out });
    code = 0;
  } catch (error) {
    process.stdout.write(
      `0042: FAILED — ${getErrorMessage(error)}. An organization in progress is rolled back; with --apply, those committed before it stay committed and a re-run migrates what is left.\n`,
    );
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
