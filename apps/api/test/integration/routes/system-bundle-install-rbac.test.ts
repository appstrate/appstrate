// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { spacePackages } from "@appstrate/db/schema";
import { writeBundleToBuffer, type Bundle } from "@appstrate/afps-runtime/bundle";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedApiKey, seedPackage } from "../../helpers/seed.ts";
import { _setSystemPackagesForTesting } from "../../../src/services/system-packages.ts";

const app = getTestApp();
const id = "@system/importable-integration";
const identity = `${id}@1.0.0` as const;
const manifest = { name: id, type: "integration", version: "1.0.0" };
const files = { "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)) };
const bundle: Bundle = {
  bundleFormatVersion: "1.0",
  root: identity,
  integrity: "",
  packages: new Map([
    [identity, { identity, manifest, files: new Map(Object.entries(files)), integrity: "" }],
  ]),
};
let ctx: TestContext;

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext();
  await seedPackage({
    id,
    orgId: null,
    type: "integration",
    source: "system",
    draftManifest: manifest,
  });
});

async function importRoot(scopes: string[]) {
  const key = await seedApiKey({
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    createdBy: ctx.user.id,
    scopes,
  });
  const bytes = writeBundleToBuffer(bundle);
  const restore = _setSystemPackagesForTesting(
    new Map([
      [
        id,
        {
          packageId: id,
          scope: "@system",
          name: "importable-integration",
          type: "integration",
          version: "1.0.0",
          manifest,
          zipBuffer: Buffer.from(bytes),
          content: "",
          files,
        },
      ],
    ]),
  );
  try {
    const form = new FormData();
    form.append("file", new File([bytes], "integration.afps-bundle"));
    return await app.request("/api/packages/import-bundle", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.rawKey}` },
      body: form,
    });
  } finally {
    restore();
  }
}

describe("system bundle root installation authorization", () => {
  it("refuses an existing system root without its install permission and writes no association", async () => {
    const response = await importRoot(["skills:write", "integrations:read"]);
    const rows = await db.select().from(spacePackages).where(eq(spacePackages.packageId, id));
    expect({
      status: response.status,
      body: await response.text(),
      installed: rows.length,
    }).toMatchObject({ status: 403, installed: 0 });
  });

  it("allows the same system root when the caller also holds the target install permission", async () => {
    const response = await importRoot([
      "skills:write",
      "integrations:read",
      "integrations:install",
    ]);
    expect(response.status, await response.clone().text()).toBe(201);
    expect(
      await db.select().from(spacePackages).where(eq(spacePackages.packageId, id)),
    ).toHaveLength(1);
  });
});
