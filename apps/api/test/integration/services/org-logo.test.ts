// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { organizations, storageDeletionJobs } from "@appstrate/db/schema";
import { downloadFile, uploadFile } from "@appstrate/db/storage";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext } from "../../helpers/auth.ts";
import {
  ORG_LOGO_BUCKET,
  logoImageVersion,
  orgLogoDeletionJob,
  orgLogoKey,
  orgLogoStorageKey,
  orgLogoStorageKeys,
  readOrgLogoImage,
  setOrgLogo,
} from "../../../src/services/org-logo.ts";
import {
  enqueueStorageDeletion,
  processStorageDeletionJobs,
} from "../../../src/services/storage-deletion.ts";
import { diffBucket } from "../../../src/services/storage-orphans.ts";

const original = new TextEncoder().encode("RIFF0000WEBP-original");
const replacement = new TextEncoder().encode("RIFF0000WEBP-replacement");

async function storedVersion(orgId: string) {
  const [org] = await db
    .select({ logo: organizations.logo })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return logoImageVersion(org?.logo ?? null)!;
}

/** Fail at COMMIT, after both the object upload and the outbox insert. */
async function withRejectedCommit(write: () => Promise<void>) {
  await db.execute(
    sql.raw(`CREATE FUNCTION _test_reject_logo() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected logo commit failure'; END $$`),
  );
  await db.execute(
    sql.raw(`CREATE CONSTRAINT TRIGGER _test_reject_logo
    AFTER UPDATE ON organizations DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION _test_reject_logo()`),
  );
  try {
    await expect(write()).rejects.toThrow();
  } finally {
    await db.execute(sql.raw("DROP TRIGGER _test_reject_logo ON organizations"));
    await db.execute(sql.raw("DROP FUNCTION _test_reject_logo()"));
  }
}

describe("organization logo publication", () => {
  beforeEach(truncateAll);

  it("keeps the previous image on a failed commit, purges the rejected upload and permits retry", async () => {
    const ctx = await createTestContext();
    await setOrgLogo(ctx.orgId, { image: original });
    const before = await storedVersion(ctx.orgId);

    await withRejectedCommit(() => setOrgLogo(ctx.orgId, { image: replacement }));
    expect(await storedVersion(ctx.orgId)).toBe(before);
    expect(await readOrgLogoImage(ctx.orgId, before)).toEqual(original);
    const rejectedJobs = await db.select().from(storageDeletionJobs);
    expect(rejectedJobs).toHaveLength(1);
    expect(rejectedJobs[0]!.reason).toBe("org_logo_failed");
    await processStorageDeletionJobs();
    expect(await downloadFile(ORG_LOGO_BUCKET, rejectedJobs[0]!.storageKey)).toBeNull();
    expect(await readOrgLogoImage(ctx.orgId, before)).toEqual(original);

    await setOrgLogo(ctx.orgId, { image: replacement });
    const after = await storedVersion(ctx.orgId);
    expect(after).not.toBe(before);
    expect(await readOrgLogoImage(ctx.orgId, before)).toEqual(original);
    expect(await readOrgLogoImage(ctx.orgId, after)).toEqual(replacement);
    await processStorageDeletionJobs();
    expect(await readOrgLogoImage(ctx.orgId, before)).toBeNull();
    expect(await readOrgLogoImage(ctx.orgId, after)).toEqual(replacement);
  });

  it("keeps the image when clearing its pointer rolls back at commit", async () => {
    const ctx = await createTestContext();
    await setOrgLogo(ctx.orgId, { image: original });
    const before = await storedVersion(ctx.orgId);
    await withRejectedCommit(() => setOrgLogo(ctx.orgId, null));
    expect(await storedVersion(ctx.orgId)).toBe(before);
    expect(await processStorageDeletionJobs()).toMatchObject({ claimed: 0 });
    expect(await readOrgLogoImage(ctx.orgId, before)).toEqual(original);
  });

  it("does not delete a published version if a commit outcome was ambiguous", async () => {
    const ctx = await createTestContext();
    await setOrgLogo(ctx.orgId, { image: original });
    const version = await storedVersion(ctx.orgId);
    await enqueueStorageDeletion(db, orgLogoDeletionJob(ctx.orgId, version, "org_logo_failed"));
    expect(await processStorageDeletionJobs()).toMatchObject({ reclaimed: 1, failed: 0 });
    expect(await readOrgLogoImage(ctx.orgId, version)).toEqual(original);
  });

  it("reads legacy logos and reconciles obsolete versions without confusing them with the live key", async () => {
    const ctx = await createTestContext();
    const legacy = "0123456789abcdef";
    const legacyKey = orgLogoKey(ctx.orgId, legacy);
    await uploadFile(ORG_LOGO_BUCKET, legacyKey, original);
    await db
      .update(organizations)
      .set({ logo: `image:${legacy}` })
      .where(eq(organizations.id, ctx.orgId));
    expect(await readOrgLogoImage(ctx.orgId, legacy)).toEqual(original);
    expect(await orgLogoStorageKeys()).toContain(legacyKey);

    await setOrgLogo(ctx.orgId, { image: replacement });
    const key = orgLogoKey(ctx.orgId, await storedVersion(ctx.orgId));
    const diff = await diffBucket(
      ORG_LOGO_BUCKET,
      [{ key: legacyKey }, { key }, { key: "unknown" }],
      await orgLogoStorageKeys(),
      { cutoffMs: Date.now(), identityOf: orgLogoStorageKey },
    );
    expect(diff.orphans).toEqual([{ key: legacyKey, size: undefined }]);
    expect(diff.unrecognized).toEqual(["unknown"]);
    await processStorageDeletionJobs();
    expect(await downloadFile(ORG_LOGO_BUCKET, legacyKey)).toBeNull();
    expect(await readOrgLogoImage(ctx.orgId, await storedVersion(ctx.orgId))).toEqual(replacement);
  });
});
