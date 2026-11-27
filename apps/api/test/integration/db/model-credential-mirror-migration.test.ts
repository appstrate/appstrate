// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0058-model-credential-needs-reconnection-mirror.ts` against seeded rows: it
 * copies a blob's death flag into the column the refresh sweep reads, and touches nothing else.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { decryptCredentials, encryptCredentials } from "@appstrate/connect";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext } from "../../helpers/auth.ts";
import { corruptCredentialBlob, seedOrgModelProviderOAuth } from "../../helpers/seed.ts";
import { runModelCredentialNeedsReconnectionMirror } from "../../../../../scripts/migration/0058-model-credential-needs-reconnection-mirror.ts";

const run = (apply: boolean, lines: string[] = []) =>
  runModelCredentialNeedsReconnectionMirror({ apply, out: (line) => lines.push(line) });

const columnOf = async (id: string) =>
  (
    await db
      .select({ flagged: modelProviderCredentials.needsReconnection })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, id))
  )[0]!.flagged;

/** The state of a credential that died before the column existed: the flag only in its blob. */
async function flagBlobOnly(id: string): Promise<void> {
  const [row] = await db
    .select({ blob: modelProviderCredentials.credentialsEncrypted })
    .from(modelProviderCredentials)
    .where(eq(modelProviderCredentials.id, id));
  const blob = {
    ...decryptCredentials<Record<string, unknown>>(row!.blob),
    needsReconnection: true,
  };
  await db
    .update(modelProviderCredentials)
    .set({
      credentialsEncrypted: encryptCredentials(blob),
      needsReconnection: false,
      needsReconnectionCause: null,
      needsReconnectionAt: null,
    })
    .where(eq(modelProviderCredentials.id, id));
}

describe("0058 — model credential needs_reconnection mirror", () => {
  let drifted: string;
  let healthy: string;
  let synced: string;
  let unreadable: string;

  beforeEach(async () => {
    await truncateAll();
    const { orgId } = await createTestContext({ orgSlug: "mirror" });
    // Blob flagged, column not: the state of a credential that died before the column existed.
    drifted = (await seedOrgModelProviderOAuth({ orgId })).id;
    await flagBlobOnly(drifted);
    healthy = (await seedOrgModelProviderOAuth({ orgId })).id;
    synced = (await seedOrgModelProviderOAuth({ orgId, needsReconnection: true })).id;
    unreadable = (await seedOrgModelProviderOAuth({ orgId })).id;
    await flagBlobOnly(unreadable);
    await corruptCredentialBlob(unreadable);
  });

  it("a dry run lists the drifted row and writes nothing", async () => {
    const lines: string[] = [];
    await run(false, lines);

    expect(lines.join("\n")).toContain(drifted);
    expect(lines).toContain("blob flagged, column not: 1");
    expect(lines).toContain("unreadable: 1");
    expect(await columnOf(drifted)).toBe(false);
  });

  it("--apply flags only the drifted row, leaves an unreadable blob alone, and a second run finds nothing", async () => {
    await run(true);

    expect(await columnOf(drifted)).toBe(true);
    expect(await columnOf(healthy)).toBe(false);
    expect(await columnOf(synced)).toBe(true);
    expect(await columnOf(unreadable)).toBe(false);

    const lines: string[] = [];
    await run(true, lines);
    expect(lines).toContain("blob flagged, column not: 0");
    expect(lines).toContain("0058: APPLIED — committed.");
  });
});
