// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0049` against the test database and the filesystem storage of tier 0: organizations
 * whose `icon` is a `0097` image pointer (`image:<version>`) are listed with the objects of the
 * `orgs` bucket in a dry run, which writes nothing; `--apply` clears those icons, keeps every other
 * one (an `emoji:` logo included) and empties the bucket; a second run finds nothing. It refuses to
 * run before drizzle `0101` has renamed the column.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizations } from "@appstrate/db/schema";
import { deleteFile, listObjects, uploadFile } from "@appstrate/db/storage";
import { runOrgIconImages } from "../migration/0049-org-icon-images.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { createTestOrg, createTestUser } from "../../apps/api/test/helpers/auth.ts";

const BUCKET = "orgs";

const lines: string[] = [];
const run = (apply: boolean) => runOrgIconImages({ apply, out: (line) => lines.push(line) });

async function bucketKeys(): Promise<string[]> {
  const keys: string[] = [];
  for await (const object of listObjects(BUCKET)) keys.push(object.key);
  return keys.sort();
}

/** An organization whose `icon` is `icon`, as `0097` or `0101` left it. */
async function orgWithIcon(userId: string, slug: string, icon: string | null): Promise<string> {
  const { org } = await createTestOrg(userId, { slug });
  await db.update(organizations).set({ icon }).where(eq(organizations.id, org.id));
  return org.id;
}

async function iconOf(id: string): Promise<string | null> {
  const [row] = await db
    .select({ icon: organizations.icon })
    .from(organizations)
    .where(eq(organizations.id, id));
  return row!.icon;
}

describe("0049 — organization image icons cleared with their bytes", () => {
  let userId: string;

  beforeEach(async () => {
    await truncateAll();
    for (const key of await bucketKeys()) await deleteFile(BUCKET, key);
    lines.length = 0;
    userId = (await createTestUser()).id;
  });

  it("counts in a dry run, clears image pointers and the bucket with --apply, then finds nothing", async () => {
    const pointerA = await orgWithIcon(userId, "mig0049-a", `image:${crypto.randomUUID()}`);
    const pointerB = await orgWithIcon(userId, "mig0049-b", `image:${crypto.randomUUID()}`);
    const emoji = await orgWithIcon(userId, "mig0049-emoji", "emoji:🚜");
    const lucide = await orgWithIcon(userId, "mig0049-lucide", "lucide:bot");
    const none = await orgWithIcon(userId, "mig0049-none", null);
    await uploadFile(BUCKET, `${pointerA}/logo`, new TextEncoder().encode("a"));
    await uploadFile(BUCKET, `${pointerB}/logo`, new TextEncoder().encode("b"));

    await run(false);
    expect(lines).toContain("organizations with an image icon: 2");
    expect(lines).toContain(`objects in the ${BUCKET} bucket: 2`);
    expect(lines.at(-1)).toBe("0049: DRY RUN — nothing written. Re-run with --apply to commit.");
    expect(await iconOf(pointerA)).toStartWith("image:");
    expect(await iconOf(pointerB)).toStartWith("image:");
    expect(await bucketKeys()).toHaveLength(2);

    lines.length = 0;
    await run(true);
    expect(lines).toContain("cleared: 2, deleted: 2");
    expect(lines).toContain("left: 0 organizations, 0 objects");
    expect(lines.at(-1)).toBe("0049: APPLIED — committed.");
    expect(await iconOf(pointerA)).toBeNull();
    expect(await iconOf(pointerB)).toBeNull();
    expect(await iconOf(emoji)).toBe("emoji:🚜");
    expect(await iconOf(lucide)).toBe("lucide:bot");
    expect(await iconOf(none)).toBeNull();
    expect(await bucketKeys()).toEqual([]);

    lines.length = 0;
    await run(true);
    expect(lines).toContain("organizations with an image icon: 0");
    expect(lines).toContain(`objects in the ${BUCKET} bucket: 0`);
    expect(lines).toContain("cleared: 0, deleted: 0");
    expect(await iconOf(emoji)).toBe("emoji:🚜");
  });

  it("empties a bucket no row points at any more", async () => {
    await uploadFile(BUCKET, "orphan/logo", new TextEncoder().encode("x"));
    await run(true);
    expect(lines).toContain("cleared: 0, deleted: 1");
    expect(await bucketKeys()).toEqual([]);
  });

  it("refuses before drizzle 0101 has renamed the column, writing nothing", async () => {
    const pointer = await orgWithIcon(userId, "mig0049-early", `image:${crypto.randomUUID()}`);
    await uploadFile(BUCKET, `${pointer}/logo`, new TextEncoder().encode("a"));
    await db.execute('ALTER TABLE "organizations" RENAME COLUMN "icon" TO "logo"');
    try {
      await expect(run(true)).rejects.toThrow("apply drizzle 0101 first");
    } finally {
      await db.execute('ALTER TABLE "organizations" RENAME COLUMN "logo" TO "icon"');
    }
    expect(await iconOf(pointer)).toStartWith("image:");
    expect(await bucketKeys()).toHaveLength(1);
  });
});
