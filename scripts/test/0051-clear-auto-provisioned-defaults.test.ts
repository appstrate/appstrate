// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0051` against the test database: a dry run lists the auto-provisioned clients still
 * flagged default and writes nothing; `--apply` clears exactly those flags, a manual default and an
 * unflagged auto client untouched; a second run finds nothing.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationOauthClients } from "@appstrate/db/schema";
import { runClearAutoProvisionedDefaults } from "../migration/0051-clear-auto-provisioned-defaults.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../apps/api/test/helpers/auth.ts";
import { seedPackage } from "../../apps/api/test/helpers/seed.ts";

const LEGACY = "@mig0051/legacy";
const MANUAL = "@mig0051/manual";

let ctx: TestContext;
const lines: string[] = [];
const run = (apply: boolean) =>
  runClearAutoProvisionedDefaults({ apply, out: (line) => lines.push(line) });

async function seedClient(
  integrationId: string,
  opts: { auto: boolean; isDefault: boolean; issuer?: string },
): Promise<string> {
  const [row] = await db
    .insert(integrationOauthClients)
    .values({
      orgId: ctx.orgId,
      spaceId: null,
      integrationId,
      authKey: "primary",
      clientId: `cid-${crypto.randomUUID().slice(0, 8)}`,
      clientSecretEncrypted: "",
      tokenEndpointAuthMethod: "none",
      isDefault: opts.isDefault,
      autoProvisioned: opts.auto,
      issuer: opts.issuer ?? null,
    })
    .returning({ id: integrationOauthClients.id });
  return row!.id;
}

async function isDefault(id: string): Promise<boolean> {
  const [row] = await db
    .select({ isDefault: integrationOauthClients.isDefault })
    .from(integrationOauthClients)
    .where(eq(integrationOauthClients.id, id));
  return row!.isDefault;
}

describe("0051 — auto-provisioned clients' default flag cleared", () => {
  beforeEach(async () => {
    await truncateAll();
    lines.length = 0;
    ctx = await createTestContext({ orgSlug: "mig0051" });
    for (const id of [LEGACY, MANUAL]) {
      await seedPackage({ id, orgId: ctx.orgId, type: "integration", source: "local" });
    }
  });

  it("lists in a dry run, clears only flagged auto clients with --apply, then finds nothing", async () => {
    const flagged = await seedClient(LEGACY, {
      auto: true,
      isDefault: true,
      issuer: "https://as.example.com",
    });
    const unflagged = await seedClient(LEGACY, {
      auto: true,
      isDefault: false,
      issuer: "https://other.example.com",
    });
    const manual = await seedClient(MANUAL, { auto: false, isDefault: true });

    await run(false);
    expect(lines).toContain("auto-provisioned clients flagged default: 1");
    expect(lines.some((line) => line.includes(flagged))).toBe(true);
    expect(lines.at(-1)).toBe("0051: DRY RUN — nothing written. Re-run with --apply to commit.");
    expect(await isDefault(flagged)).toBe(true);

    lines.length = 0;
    await run(true);
    expect(lines).toContain("cleared: 1");
    expect(lines).toContain("left: 0");
    expect(lines.at(-1)).toBe("0051: APPLIED — committed.");
    expect(await isDefault(flagged)).toBe(false);
    expect(await isDefault(unflagged)).toBe(false);
    expect(await isDefault(manual)).toBe(true);

    lines.length = 0;
    await run(true);
    expect(lines).toContain("auto-provisioned clients flagged default: 0");
    expect(lines).toContain("cleared: 0");
  });
});
