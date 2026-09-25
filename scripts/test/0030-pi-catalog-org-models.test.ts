// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0030`: the pure planner against a synthetic catalog, then the run
 * against the test database with the platform's real registry (Pi's offer).
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "@appstrate/db/client";
import {
  planPiCatalogMigration,
  registryCatalog,
  runPiCatalogMigration,
  writePlan,
  type CatalogView,
  type OrgModelRow,
  type PiCatalogSnapshot,
} from "../migration/0030-pi-catalog-org-models.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { createTestContext } from "../../apps/api/test/helpers/auth.ts";
import {
  seedOrgModel,
  seedOrgModelProviderKey,
  seedPackage,
  seedSchedule,
  seedSpacePackage,
} from "../../apps/api/test/helpers/seed.ts";
import { seedTestModelProviders } from "../../apps/api/test/helpers/model-providers.ts";
import {
  registerModelProviders,
  resetModelProviders,
} from "../../apps/api/src/services/model-providers/registry.ts";

// ─── The pure planner ─────────────────────────────────────

const ORG = "00000000-0000-4000-8000-000000000301";
const OTHER_ORG = "00000000-0000-4000-8000-000000000302";

/** `named` offers `known`, `strict`, `warm` and features `warm` then `known`; `gateway` takes anything. */
const catalog: CatalogView = {
  offers: (providerId, modelId) =>
    providerId === "gateway"
      ? true
      : providerId === "named"
        ? ["known", "strict", "warm"].includes(modelId)
        : null,
  featured: (providerId) => (providerId === "named" ? ["warm", "known"] : []),
};

const row = (id: string, providerId: string, modelId: string, extra: Partial<OrgModelRow> = {}) =>
  ({
    id,
    orgId: ORG,
    credentialId: `cred-${providerId}`,
    providerId,
    modelId,
    enabled: true,
    ...extra,
  }) satisfies OrgModelRow;

const UNKNOWN = row("m-unknown", "named", "retired-model");
const KNOWN = row("m-known", "named", "known");
const STRICT = row("m-strict", "named", "strict");
const WARM = row("m-warm", "named", "warm");
const GATEWAY = row("m-gateway", "gateway", "anything-goes");
const ORPHAN = row("m-orphan", "gone-module", "whatever");

const snapshot = (over: Partial<PiCatalogSnapshot> = {}): PiCatalogSnapshot => ({
  orgModels: [UNKNOWN, KNOWN, STRICT, WARM, GATEWAY, ORPHAN],
  orgDefaults: [],
  spacePins: [],
  scheduleOverrides: [],
  ...over,
});

describe("planPiCatalogMigration", () => {
  it("deletes a named-provider row outside the offer, clears the pins naming it, leaves an unregistered provider alone", () => {
    const plan = planPiCatalogMigration(
      snapshot({
        spacePins: [
          { spaceId: "s1", packageId: "@o/a", modelId: UNKNOWN.id },
          { spaceId: "s1", packageId: "@o/b", modelId: KNOWN.id },
        ],
        scheduleOverrides: [
          { scheduleId: "sch_1", modelId: UNKNOWN.id },
          { scheduleId: "sch_2", modelId: GATEWAY.id },
          { scheduleId: "sch_3", modelId: ORPHAN.id },
        ],
      }),
      catalog,
    );
    expect(plan.deletions.map((r) => r.id)).toEqual([UNKNOWN.id]);
    expect(plan.unregistered.map((r) => r.id)).toEqual([ORPHAN.id]);
    expect(plan.clearedSpacePins).toEqual([{ spaceId: "s1", packageId: "@o/a", from: UNKNOWN.id }]);
    expect(plan.clearedScheduleOverrides).toEqual([{ scheduleId: "sch_1", from: UNKNOWN.id }]);
  });

  it("repoints a deleted org default to the first featured survivor of the same credential", () => {
    const plan = planPiCatalogMigration(
      snapshot({
        orgDefaults: [
          { orgId: ORG, modelId: UNKNOWN.id },
          { orgId: OTHER_ORG, modelId: "m-other" },
        ],
      }),
      catalog,
    );
    // `known` is older, but `warm` is featured first.
    expect(plan.orgDefaults).toEqual([{ orgId: ORG, from: UNKNOWN.id, to: WARM.id }]);
  });

  it("falls back to the oldest survivor when none is featured", () => {
    const plan = planPiCatalogMigration(
      snapshot({
        orgModels: [
          UNKNOWN,
          row("m-strict-old", "named", "strict"),
          row("m-strict-new", "named", "strict"),
        ],
        orgDefaults: [{ orgId: ORG, modelId: UNKNOWN.id }],
      }),
      catalog,
    );
    expect(plan.orgDefaults).toEqual([{ orgId: ORG, from: UNKNOWN.id, to: "m-strict-old" }]);
  });

  it("repoints to NULL when no enabled row of the same credential and org survives", () => {
    const plan = planPiCatalogMigration(
      snapshot({
        orgModels: [
          UNKNOWN,
          row("m-disabled", "named", "known", { enabled: false }),
          row("m-other-cred", "named", "strict", { credentialId: "cred-2" }),
          row("m-other-org", "named", "strict", { orgId: OTHER_ORG }),
        ],
        orgDefaults: [{ orgId: ORG, modelId: UNKNOWN.id }],
      }),
      catalog,
    );
    expect(plan.orgDefaults).toEqual([{ orgId: ORG, from: UNKNOWN.id, to: null }]);
  });
});

// ─── Against the database, with Pi's real offer ────────────

const BACKUP_DIR = `${Bun.env.TMPDIR ?? "/tmp"}/appstrate-0030-${crypto.randomUUID()}`;

async function seedFixture() {
  const ctx = await createTestContext({ orgSlug: "mig0030" });
  const { orgId, defaultSpaceId: spaceId } = ctx;
  const deepseek = await seedOrgModelProviderKey({ orgId, providerId: "deepseek" });
  const compatible = await seedOrgModelProviderKey({
    orgId,
    providerId: "openai-compatible",
    baseUrl: "http://llm.internal/v1",
  });
  const openrouter = await seedOrgModelProviderKey({ orgId, providerId: "openrouter" });
  const retired = await seedOrgModel({
    orgId,
    credentialId: deepseek.id,
    modelId: "deepseek-chat",
    label: "Old chat",
  });
  const offered = await seedOrgModel({
    orgId,
    credentialId: deepseek.id,
    modelId: "deepseek-v4-pro",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  // Newer than `offered`, but featured first by the deepseek definition.
  const flash = await seedOrgModel({
    orgId,
    credentialId: deepseek.id,
    modelId: "deepseek-flash",
    createdAt: new Date("2026-02-01T00:00:00Z"),
  });
  const gateway = await seedOrgModel({ orgId, credentialId: compatible.id, modelId: "my-model" });
  const liveSearch = await seedOrgModel({
    orgId,
    credentialId: openrouter.id,
    modelId: "someone/not-in-pi-at-all",
  });
  await db.execute(
    `UPDATE organizations SET default_model_id = '${retired.id}' WHERE id = '${orgId}'`,
  );
  const pinned = await seedPackage({ id: "@mig0030/pinned", orgId });
  await seedSpacePackage(spaceId, pinned.id, { modelId: retired.id });
  await seedSchedule({
    id: "sch_mig0030",
    packageId: pinned.id,
    orgId,
    spaceId,
    userId: ctx.user.id,
    modelIdOverride: retired.id,
  });

  // An org whose only deepseek row is retired: its default falls to NULL.
  const bare = await createTestContext({ orgSlug: "mig0030-bare", email: "bare@mig0030.test" });
  const bareKey = await seedOrgModelProviderKey({ orgId: bare.orgId, providerId: "deepseek" });
  const bareRetired = await seedOrgModel({
    orgId: bare.orgId,
    credentialId: bareKey.id,
    modelId: "deepseek-reasoner",
  });
  await db.execute(
    `UPDATE organizations SET default_model_id = '${bareRetired.id}' WHERE id = '${bare.orgId}'`,
  );
  return {
    orgId,
    spaceId,
    bareOrgId: bare.orgId,
    retired: retired.id,
    kept: [offered.id, flash.id, gateway.id, liveSearch.id],
    flash: flash.id,
    bareRetired: bareRetired.id,
  };
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

const rows = <T>(query: string) =>
  db.execute(query).then((r) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[]);

async function state(fx: Fixture) {
  return {
    models: (await rows<{ id: string }>(`SELECT id::text FROM org_models ORDER BY id`)).map(
      (r) => r.id,
    ),
    orgDefaults: await rows(
      `SELECT id::text, default_model_id FROM organizations
        WHERE id IN ('${fx.orgId}', '${fx.bareOrgId}') ORDER BY id`,
    ),
    spacePins: await rows(`SELECT package_id, model_id FROM space_packages ORDER BY package_id`),
    schedules: await rows(`SELECT id, model_id_override FROM package_schedules ORDER BY id`),
  };
}

const backups = () =>
  Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: BACKUP_DIR, onlyFiles: true })).catch(
    () => [],
  );

describe("runPiCatalogMigration", () => {
  let fx: Fixture;
  const lines: string[] = [];
  const run = (apply: boolean, systemKeys: unknown[] = []) =>
    runPiCatalogMigration({
      apply,
      catalog: registryCatalog(),
      systemKeys,
      backupPath: `${BACKUP_DIR}/0030-backup-${lines.length}.json`,
      out: (line) => lines.push(line),
    });

  beforeEach(async () => {
    seedTestModelProviders();
    await Bun.$`rm -rf ${BACKUP_DIR}`.quiet();
    await truncateAll();
    lines.length = 0;
    fx = await seedFixture();
  });

  afterAll(async () => {
    seedTestModelProviders();
    await Bun.$`rm -rf ${BACKUP_DIR}`.quiet();
  });

  it("writes nothing on a dry run, backup included", async () => {
    const before = await state(fx);
    const plan = await run(false);
    expect(plan.deletions.map((r) => r.id).sort()).toEqual([fx.retired, fx.bareRetired].sort());
    expect(await state(fx)).toEqual(before);
    expect(await backups()).toEqual([]);
    expect(lines.join("\n")).toMatch(
      /would write .*0030-backup-.*\.json: 2 org_models row\(s\), 4 pointer/,
    );
  });

  it("deletes, repoints the default to the featured survivor, clears pointers, backs up, and converges", async () => {
    await run(true);
    const after = await state(fx);
    expect(after.models).toEqual([...fx.kept].sort());
    expect(after.orgDefaults).toEqual(
      [
        { id: fx.orgId, default_model_id: fx.flash },
        { id: fx.bareOrgId, default_model_id: null },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(after.spacePins).toEqual([{ package_id: "@mig0030/pinned", model_id: null }]);
    expect(after.schedules).toEqual([{ id: "sch_mig0030", model_id_override: null }]);
    expect(lines.join("\n")).toContain(`organizations ${fx.bareOrgId}: default_model_id → NULL`);

    const [file] = await backups();
    const backup = await Bun.file(`${BACKUP_DIR}/${file}`).json();
    expect(backup.org_models.find((r: { id: string }) => r.id === fx.retired)).toMatchObject({
      label: "Old chat",
      model_id: "deepseek-chat",
    });
    expect(backup.org_models).toHaveLength(2);
    expect(backup.organizations).toContainEqual({
      id: fx.orgId,
      default_model_id: { before: fx.retired, after: fx.flash },
    });
    expect(backup.space_packages).toEqual([
      {
        space_id: fx.spaceId,
        package_id: "@mig0030/pinned",
        model_id: { before: fx.retired, after: null },
      },
    ]);
    expect(backup.package_schedules).toEqual([
      { id: "sch_mig0030", model_id_override: { before: fx.retired, after: null } },
    ]);

    expect((await run(true)).deletions).toEqual([]);
    expect(await state(fx)).toEqual(after);
  });

  it("names a backup written for a change that was not committed", async () => {
    const before = await state(fx);
    const backupPath = `${BACKUP_DIR}/0030-backup-uncommitted.json`;
    await expect(
      runPiCatalogMigration({
        apply: true,
        catalog: registryCatalog(),
        systemKeys: [],
        backupPath,
        out: (line) => {
          lines.push(line);
          if (line.startsWith("backup: wrote")) throw new Error("fails after the backup");
        },
      }),
    ).rejects.toThrow(/fails after the backup/);
    expect(await state(fx)).toEqual(before);
    expect(await Bun.file(backupPath).exists()).toBe(true);
    expect(lines).toContain(`backup: ${backupPath} was NOT committed — discard it`);
  });

  it("reports a declared system model outside the offer without its key, and refuses to apply", async () => {
    const keys = [
      {
        id: "ds",
        providerId: "deepseek",
        apiKey: "sk-never-printed",
        models: [{ id: "sys-flash", modelId: "deepseek-v4-flash", label: "Flash", aliased: true }],
      },
    ];
    await run(false, keys);
    expect(lines.join("\n")).toContain(`entry "ds": deepseek/deepseek-v4-flash`);
    expect(lines.join("\n")).not.toContain("sk-never-printed");

    const before = await state(fx);
    await expect(run(true, keys)).rejects.toThrow(/SYSTEM_PROVIDER_KEYS/);
    expect(await state(fx)).toEqual(before);
    expect(await backups()).toEqual([]);
  });

  it("leaves a provider MODULES does not register alone", async () => {
    resetModelProviders();
    registerModelProviders([]);
    const before = await state(fx);
    expect((await run(true)).unregistered).toHaveLength(6);
    expect(await state(fx)).toEqual(before);
  });

  it("guards each delete on the model id read", async () => {
    const stale = planPiCatalogMigration(
      {
        orgModels: [row(fx.retired, "named", "deepseek-chat-renamed", { orgId: fx.orgId })],
        orgDefaults: [],
        spacePins: [],
        scheduleOverrides: [],
      },
      catalog,
    );
    expect(stale.deletions).toHaveLength(1);
    await expect(db.transaction((tx) => writePlan(tx, stale))).rejects.toThrow(/changed since/);
    expect((await state(fx)).models).toContain(fx.retired);
  });
});
