#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0062 — every model connection and every organization model joins a model configuration:
 *
 *   set -a && . ./.env && set +a && bun scripts/migration/0062-model-configs.ts [--apply]
 *
 * Drizzle `0119` adds `model_configs` and the nullable `config_id` on
 * `model_provider_credentials` and `org_models`. This fills them:
 *
 * - a connection with no configuration joins the configuration keyed on
 *   (`configProviderOf(provider_id)`, its `base_url_override` when the provider is a gateway,
 *   else none), created when missing — label the provider's display name (`host · name` for a
 *   gateway), `personal_connections_allowed` the organization's retired
 *   `personal_model_credentials` setting (absent = true). A connection of an unregistered provider
 *   joins a configuration of its own provider id, reported (the platform cannot serve it while no
 *   module in `MODULES` registers it);
 * - a model bound to a connection (`credential_id`) joins that connection's configuration, an
 *   unbound one its provider's family configuration (a gateway's: its default endpoint);
 * - two NON-aliased models landing on the same (configuration, model id) are one (the new unique
 *   index is partial on `aliased = false`; an alias keeps its own row and pointers, even when it
 *   shares its backing model's id): the enabled one is kept, then the oldest;
 *   `organizations.default_model_id`, `space_packages.model_id` and
 *   `package_schedules.model_id_override` are repointed to it and the others deleted
 *   (`runs.model_id` and `llm_usage` are history and are not touched); the fields of the deleted
 *   row that differ from the kept one (label, cost, capabilities) are lost and reported;
 * - the retired `personal_model_credentials` key is removed from `org_settings`.
 *
 * Two kinds of configuration are created without anyone having chosen them and are flagged
 * apart: one for a provider no loaded module registers, and one on a gateway provider's
 * `defaultBaseUrl` for an unbound gateway model (an endpoint nobody picked: edit or delete it).
 *
 * The report lists, per model, the connection that served it before (its binding, personal or
 * not) and the organization connection serving it after (the oldest organization connection of its configuration that
 * serves the model), every difference by id. Personal connections are not compared: who pays
 * with one depends on the caller.
 *
 * Run after drizzle `0119` has applied and BEFORE the app starts: the platform refuses to boot
 * until it has run (the `0062` entry of `PENDING_DATA_SCRIPTS`,
 * `apps/api/src/lib/boot-guards/pending-data-scripts.ts`). Dry run by default: plans and reports,
 * writes nothing. With `--apply`, one transaction per organization; it exits 1 unless no row is
 * left without a configuration. Idempotent. Counts UNMEASURED: rehearse on a restored dump and
 * record them in the README's Log. Targets `DATABASE_URL` or `PGLITE_DATA_DIR`, exits 2 with
 * neither (`lib/database-target.ts`).
 */

import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { getErrorMessage } from "@appstrate/core/errors";
import { describeDatabaseTarget, exitUnlessDatabaseNamed } from "./lib/database-target.ts";
import {
  getModelProvider,
  registerModelProviders,
} from "../../apps/api/src/services/model-providers/registry.ts";
import {
  configProviderOf,
  isGatewayProvider,
  rankCandidates,
} from "../../apps/api/src/services/model-providers/credential-chain.ts";
import { getModuleRegistry, importModule } from "../../apps/api/src/lib/modules/module-loader.ts";

interface CredentialRow {
  id: string;
  org_id: string;
  provider_id: string;
  owner_user_id: string | null;
  base_url_override: string | null;
  config_id: string | null;
  created_at: Date | string;
}

interface ModelRow {
  id: string;
  org_id: string;
  model_id: string;
  label: string;
  provider_id: string | null;
  credential_id: string | null;
  config_id: string | null;
  enabled: boolean;
  aliased: boolean;
  input: unknown;
  context_window: number | null;
  max_tokens: number | null;
  reasoning: boolean | null;
  cost: unknown;
  created_at: Date | string;
}

/** What a merge drops: the fields of the model kept that differ from the one deleted. */
const MERGED_FIELDS = [
  ["label", "label"],
  ["cost", "cost"],
  ["input", "input"],
  ["context_window", "context window"],
  ["max_tokens", "max tokens"],
  ["reasoning", "reasoning"],
] as const;
const differingFields = (keep: ModelRow, drop: ModelRow): string[] =>
  MERGED_FIELDS.filter(([k]) => JSON.stringify(keep[k]) !== JSON.stringify(drop[k])).map(
    ([k, name]) => `${name} ${JSON.stringify(drop[k])} (kept ${JSON.stringify(keep[k])})`,
  );

interface ConfigRow {
  id: string;
  org_id: string;
  provider_id: string;
  base_url: string | null;
}

const configKey = (providerId: string, baseUrl: string | null) =>
  `${providerId}\u0000${baseUrl ?? ""}`;
const time = (d: Date | string) => new Date(d).getTime();

/**
 * Registers the model providers of the modules `MODULES` loads, as the platform does at boot
 * (`scripts/verify-system-models.ts`); one already registered (a second run in the same
 * process) is kept.
 */
async function registerProviders(): Promise<string[]> {
  const names: string[] = [];
  for (const specifier of getModuleRegistry()) {
    const defs = (await importModule(specifier)).modelProviders?.() ?? [];
    registerModelProviders(defs.filter((def) => !getModelProvider(def.providerId)));
    names.push(...defs.map((d) => d.providerId));
  }
  return names;
}

/**
 * The configuration a connection belongs to. A provider no loaded module registers keeps a
 * configuration of its own id (its endpoint override included): the platform cannot serve it
 * today, and the row must not hold the boot guard.
 */
function connectionKey(row: CredentialRow): { providerId: string; baseUrl: string | null } {
  if (!getModelProvider(row.provider_id)) {
    return { providerId: row.provider_id, baseUrl: row.base_url_override ?? null };
  }
  const providerId = configProviderOf(row.provider_id);
  // A gateway connection without an endpoint override used the provider default.
  const baseUrl = isGatewayProvider(row.provider_id)
    ? (row.base_url_override ?? getModelProvider(row.provider_id)?.defaultBaseUrl ?? null)
    : null;
  return { providerId, baseUrl };
}

function configLabel(providerId: string, baseUrl: string | null): string {
  const name = getModelProvider(providerId)?.displayName ?? providerId;
  if (!baseUrl) return name;
  try {
    return `${new URL(baseUrl).host} · ${name}`;
  } catch {
    return `${baseUrl} · ${name}`;
  }
}

export async function runModelConfigs(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<void> {
  const { apply, out } = options;
  const { db, toRows } = await import("@appstrate/db/client");
  out(await describeDatabaseTarget());
  out(`providers registered from MODULES: ${(await registerProviders()).join(", ")}`);

  const orgIds = toRows<{ org_id: string }>(
    await db.execute(sql`
      SELECT org_id FROM model_provider_credentials WHERE config_id IS NULL
      UNION SELECT org_id FROM org_models WHERE config_id IS NULL
      ORDER BY org_id`),
  ).map((r) => r.org_id);
  out(`organizations to migrate: ${orgIds.length}`);

  let unregistered = 0;
  let unregisteredConfigs = 0;
  let unchosenEndpoints = 0;
  let lossyMerges = 0;
  let servingChanges = 0;
  for (const orgId of orgIds) {
    const work = async (tx: typeof db) => {
      const settings = toRows<{ personal: unknown }>(
        await tx.execute(
          sql`SELECT org_settings->'personal_model_credentials' AS personal FROM organizations WHERE id = ${orgId}`,
        ),
      )[0];
      const personalAllowed = settings?.personal !== false;
      const credentials = toRows<CredentialRow>(
        await tx.execute(sql`
          SELECT id, org_id, provider_id, owner_user_id, base_url_override, config_id, created_at
          FROM model_provider_credentials WHERE org_id = ${orgId} ORDER BY created_at, id`),
      );
      const models = toRows<ModelRow>(
        await tx.execute(sql`
          SELECT id, org_id, model_id, label, provider_id, credential_id, config_id, enabled,
                 aliased, input, context_window, max_tokens, reasoning, cost, created_at
          FROM org_models WHERE org_id = ${orgId} ORDER BY created_at, id`),
      );
      const configs = toRows<ConfigRow>(
        await tx.execute(
          sql`SELECT id, org_id, provider_id, base_url FROM model_configs WHERE org_id = ${orgId}`,
        ),
      );
      const byKey = new Map(configs.map((c) => [configKey(c.provider_id, c.base_url), c]));
      const byId = new Map(configs.map((c) => [c.id, c]));

      const ensure = async (
        providerId: string,
        baseUrl: string | null,
        flag?: "unregistered" | "unchosen-endpoint",
      ): Promise<ConfigRow> => {
        const existing = byKey.get(configKey(providerId, baseUrl));
        if (existing) return existing;
        if (flag === "unregistered") {
          unregisteredConfigs++;
          out(`  [${orgId}] UNREGISTERED PROVIDER: creating a configuration for ${providerId}`);
        } else if (flag === "unchosen-endpoint") {
          unchosenEndpoints++;
          out(
            `  [${orgId}] UNCHOSEN ENDPOINT: creating a configuration on ${providerId}'s default endpoint ${baseUrl} for an unbound model`,
          );
        }
        const label = configLabel(providerId, baseUrl);
        out(`  [${orgId}] config ${providerId}${baseUrl ? ` @ ${baseUrl}` : ""} — "${label}"`);
        const created: ConfigRow = apply
          ? toRows<ConfigRow>(
              await tx.execute(sql`
                INSERT INTO model_configs (org_id, provider_id, label, base_url, personal_connections_allowed)
                VALUES (${orgId}, ${providerId}, ${label}, ${baseUrl}, ${personalAllowed})
                RETURNING id, org_id, provider_id, base_url`),
            )[0]!
          : {
              id: `planned:${providerId}:${baseUrl ?? ""}`,
              org_id: orgId,
              provider_id: providerId,
              base_url: baseUrl,
            };
        byKey.set(configKey(providerId, baseUrl), created);
        byId.set(created.id, created);
        return created;
      };

      // Connections.
      const credConfig = new Map<string, string>();
      for (const c of credentials) {
        if (c.config_id) {
          credConfig.set(c.id, c.config_id);
          continue;
        }
        const key = connectionKey(c);
        if (!getModelProvider(c.provider_id)) {
          unregistered++;
          out(
            `  [${orgId}] unregistered provider, own configuration: connection ${c.id} ${c.provider_id}`,
          );
        }
        const cfg = await ensure(
          key.providerId,
          key.baseUrl,
          getModelProvider(c.provider_id) ? undefined : "unregistered",
        );
        credConfig.set(c.id, cfg.id);
        if (apply) {
          await tx.execute(
            sql`UPDATE model_provider_credentials SET config_id = ${cfg.id} WHERE id = ${c.id}`,
          );
        }
      }

      // Models: target configuration.
      const target = new Map<string, string>();
      for (const m of models) {
        if (m.config_id) {
          target.set(m.id, m.config_id);
          continue;
        }
        const bound = m.credential_id ? credConfig.get(m.credential_id) : undefined;
        if (bound) {
          target.set(m.id, bound);
          continue;
        }
        // `provider_id` was NOT NULL until 0119, so an unmigrated row carries one.
        const providerId = m.provider_id!;
        if (!getModelProvider(providerId)) {
          unregistered++;
          out(`  [${orgId}] unregistered provider, own configuration: model ${m.id} ${providerId}`);
          target.set(m.id, (await ensure(providerId, null, "unregistered")).id);
          continue;
        }
        // An unbound gateway model served nothing before (a personal connection could not carry
        // an endpoint): it joins the provider's default endpoint, which an admin can edit.
        const baseUrl = isGatewayProvider(providerId)
          ? (getModelProvider(providerId)?.defaultBaseUrl ?? null)
          : null;
        target.set(
          m.id,
          (
            await ensure(
              configProviderOf(providerId),
              baseUrl,
              baseUrl ? "unchosen-endpoint" : undefined,
            )
          ).id,
        );
      }

      // Duplicates on (configuration, model id) among non-aliased rows: keep the enabled one,
      // then the oldest.
      const groups = new Map<string, ModelRow[]>();
      for (const m of models) {
        const cfg = target.get(m.id);
        if (!cfg || m.aliased) continue;
        const k = `${cfg}\u0000${m.model_id}`;
        groups.set(k, [...(groups.get(k) ?? []), m]);
      }
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const [keep, ...drop] = [...group].sort(
          (a, b) =>
            Number(b.enabled) - Number(a.enabled) || time(a.created_at) - time(b.created_at),
        );
        for (const d of drop) {
          out(`  [${orgId}] duplicate model ${d.id} (${d.model_id}) merged into ${keep!.id}`);
          const lost = differingFields(keep!, d);
          if (lost.length > 0) {
            lossyMerges++;
            out(`  [${orgId}] merge drops from ${d.id}: ${lost.join("; ")}`);
          }
          target.delete(d.id);
          if (!apply) continue;
          await tx.execute(
            sql`UPDATE organizations SET default_model_id = ${keep!.id} WHERE id = ${orgId} AND default_model_id = ${d.id}`,
          );
          await tx.execute(
            sql`UPDATE space_packages SET model_id = ${keep!.id} WHERE model_id = ${d.id}`,
          );
          await tx.execute(
            sql`UPDATE package_schedules SET model_id_override = ${keep!.id} WHERE model_id_override = ${d.id}`,
          );
          await tx.execute(sql`DELETE FROM org_models WHERE id = ${d.id}`);
        }
      }

      // Serving, before vs after, for each model kept.
      for (const m of models) {
        const cfgId = target.get(m.id);
        if (!cfgId) continue;
        const cfg = byId.get(cfgId);
        if (!cfg) continue;
        const connections = credentials
          .filter((c) => credConfig.get(c.id) === cfgId)
          .map((c) => ({
            ...c,
            providerId: c.provider_id,
            ownerUserId: c.owner_user_id,
            createdAt: new Date(c.created_at),
          }));
        const after =
          rankCandidates(connections, {
            configProviderId: cfg.provider_id,
            personalConnectionsAllowed: false,
            modelId: m.model_id,
            aliased: m.aliased,
            payerUserId: null,
          })[0]?.id ?? null;
        const boundTo = m.credential_id
          ? credentials.find((c) => c.id === m.credential_id)
          : undefined;
        // A personal binding served its owner only: whatever organization connection serves the
        // model now (or none) is a change.
        const before = boundTo?.id ?? null;
        if (before !== after) {
          servingChanges++;
          const was = !boundTo
            ? "unbound"
            : boundTo.owner_user_id === null
              ? boundTo.id
              : `personal connection ${boundTo.id}`;
          out(
            `  [${orgId}] serving changes: model ${m.id} (${m.model_id}) ${was} -> ${after ?? "none"}`,
          );
        }
        if (apply && !m.config_id) {
          await tx.execute(sql`UPDATE org_models SET config_id = ${cfgId} WHERE id = ${m.id}`);
        }
      }

      if (apply) {
        await tx.execute(
          sql`UPDATE organizations SET org_settings = org_settings - 'personal_model_credentials' WHERE id = ${orgId} AND org_settings ? 'personal_model_credentials'`,
        );
      }
    };

    if (apply) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
        await work(tx as unknown as typeof db);
      });
    } else {
      await work(db);
    }
  }

  out(`rows of a provider no loaded module registers (own configuration): ${unregistered}`);
  out(`configurations created for a provider no loaded module registers: ${unregisteredConfigs}`);
  out(
    `configurations created on a gateway default endpoint for an unbound model: ${unchosenEndpoints}`,
  );
  out(`merges that drop differing fields: ${lossyMerges}`);
  out(`models whose serving organization connection changes: ${servingChanges}`);
  if (!apply) {
    out("0062: DRY RUN — nothing written. Re-run with --apply to commit.");
    return;
  }
  const left = toRows<{ n: number | string }>(
    await db.execute(sql`
      SELECT (SELECT count(*) FROM model_provider_credentials WHERE config_id IS NULL)
           + (SELECT count(*) FROM org_models WHERE config_id IS NULL) AS n`),
  )[0];
  out(`left without a configuration: ${Number(left?.n ?? 0)}`);
  if (Number(left?.n ?? 0) !== 0)
    throw new Error("rows without a configuration are left after --apply");
  out("0062: APPLIED — committed.");
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
    out(`0062 — ${apply ? "APPLY" : "DRY RUN"}`);
    await runModelConfigs({ apply, out });
    code = 0;
  } catch (error) {
    process.stdout.write(
      `0062: FAILED — ${getErrorMessage(error)}. Each organization is one transaction; a re-run with --apply finishes what is left.\n`,
    );
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
