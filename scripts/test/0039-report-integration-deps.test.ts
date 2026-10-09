// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0039` against the test database: the report lists the integrations each agent
 * declares (draft, `latest`, and the version an enabled schedule pins, by exact version or
 * range), the enabled schedules firing one, and counts every schedule holding an empty
 * connection set, enabled and disabled apart, past rows whose overrides are not an object.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { db } from "@appstrate/db/client";
import { packageDistTags } from "@appstrate/db/schema";
import { readSnapshot, report } from "../migration/0039-report-integration-deps.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../apps/api/test/helpers/auth.ts";
import { seedPackage, seedPackageVersion, seedSchedule } from "../../apps/api/test/helpers/seed.ts";

const SVC = "@mig0039/svc";
const LEGACY = "@mig0039/legacy";
const NOW_OPTIONAL = "@mig0039/now-optional";
const PINNED_OLD = "@mig0039/pinned-old";
const PLAIN = "@mig0039/plain";

let ctx: TestContext;

function agentManifest(id: string, version: string, integrations: Record<string, boolean>) {
  const ids = Object.keys(integrations);
  return {
    name: id,
    version,
    type: "agent",
    schema_version: "0.2",
    dependencies: { integrations: Object.fromEntries(ids.map((i) => [i, "^1.0.0"])) },
    integrations_configuration: Object.fromEntries(
      ids.map((i) => [i, integrations[i] ? { required: true } : {}]),
    ),
  };
}

async function seedAgentVersions(
  id: string,
  draft: Record<string, boolean>,
  published: Record<string, Record<string, boolean>>,
  latest: string,
) {
  await seedPackage({ id, orgId: ctx.orgId, draftManifest: agentManifest(id, "9.9.9", draft) });
  for (const [version, integrations] of Object.entries(published)) {
    const row = await seedPackageVersion({
      packageId: id,
      version,
      manifest: agentManifest(id, version, integrations),
    });
    if (version === latest) {
      await db.insert(packageDistTags).values({ packageId: id, tag: "latest", versionId: row.id });
    }
  }
}

const schedule = (packageId: string, extra: Partial<Parameters<typeof seedSchedule>[0]>) =>
  seedSchedule({
    packageId,
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    userId: ctx.user.id,
    ...extra,
  });

const run = (query: string) =>
  db.execute(query).then((r) => (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows));

/** The report's table rows, split into cells. */
const cells = (lines: string[]) => lines.map((line) => line.split(/\s{2,}/));

describe("0039 — integration dependency report", () => {
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "mig0039" });
  });

  it("lists pinned versions, the schedules firing them, and empty connection sets", async () => {
    await seedAgentVersions(NOW_OPTIONAL, { [SVC]: false }, { "1.0.0": { [SVC]: true } }, "1.0.0");
    // Neither the draft nor `latest` declares anything: only the pinned 1.0.0 does.
    await seedAgentVersions(PINNED_OLD, {}, { "1.0.0": { [LEGACY]: false }, "2.0.0": {} }, "2.0.0");
    await seedAgentVersions(PLAIN, {}, {}, "");

    await schedule(PINNED_OLD, { name: "exact", versionOverride: "1.0.0" });
    await schedule(PINNED_OLD, { name: "range", versionOverride: "~1.0.0" });
    await schedule(NOW_OPTIONAL, { name: "none", connectionOverrides: { [SVC]: [] } });
    await schedule(NOW_OPTIONAL, {
      name: "picked",
      connectionOverrides: { [SVC]: ["00000000-0000-4000-8000-000000000039"] },
    });
    await schedule(PLAIN, { name: "plain" });
    // Not objects: `jsonb_each` would raise on either, aborting the whole report.
    await schedule(PLAIN, { name: "array" });
    await schedule(PLAIN, { name: "json-null", enabled: false });
    await run(
      `UPDATE package_schedules SET connection_overrides = '[[]]'::jsonb WHERE name = 'array'`,
    );
    await run(
      `UPDATE package_schedules SET connection_overrides = 'null'::jsonb WHERE name = 'json-null'`,
    );
    await schedule(NOW_OPTIONAL, {
      name: "off",
      enabled: false,
      connectionOverrides: { [SVC]: [] },
    });

    const lines = report(await readSnapshot(run));
    const rows = cells(lines);

    const declarations = rows
      .filter((r) => r.length === 5 && r[2]!.startsWith("@mig0039/"))
      .map((r) => [r[2], r[3], r[4]]);
    expect(declarations).toEqual([
      [NOW_OPTIONAL, "1.0.0", `${SVC} (required)`],
      [NOW_OPTIONAL, "draft", `${SVC} (optional)`],
      [PINNED_OLD, "1.0.0", `${LEGACY} (optional)`],
    ]);

    const fired = rows
      .filter((r) => r.length >= 6 && r[2]!.startsWith("@mig0039/"))
      .map((r) => [r[2], r[4]])
      .sort();
    expect(fired).toEqual([
      [NOW_OPTIONAL, "none"],
      [NOW_OPTIONAL, "picked"],
      [PINNED_OLD, "exact"],
      [PINNED_OLD, "range"],
    ]);

    expect(lines.slice(-2)).toEqual([
      "2 agent(s) declare integrations: 3 declaration(s), 2 optional; 4 enabled schedule(s) fire one of them.",
      "Schedules holding an empty connection set (expected 0 each): 1 enabled, 1 disabled.",
    ]);
  });
});
