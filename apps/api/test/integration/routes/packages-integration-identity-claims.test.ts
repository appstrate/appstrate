// SPDX-License-Identifier: Apache-2.0

/**
 * Identity claim key casing (#1545): WRITE-strict, READ-lenient.
 *
 * Every path that writes an integration manifest refuses a non-snake_case
 * `identity_claims` key (`CONFIG_BY_TYPE.checkManifest`). Reading one that is
 * already stored must keep working: published versions are immutable, and
 * every system integration declared `accountId` before the rule.
 */

import { etagVersion, ifMatch } from "../../helpers/etag.ts";
import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { packages, packageVersions } from "@appstrate/db/schema";
import * as storage from "@appstrate/db/storage";
import { computeIntegrity } from "@appstrate/core/integrity";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { apiIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { uploadPackageFiles } from "../../../src/services/package-items/storage.ts";
import {
  AGENT_PACKAGES_BUCKET,
  versionZipKey,
} from "../../../src/services/package-storage-keys.ts";

const app = getTestApp();

const enc = (s: string) => new TextEncoder().encode(s);

const ID = "@claimorg/claims";
const CAMEL_FIELD = "manifest.auths.api.identity_claims.accountId";

function manifest(identity_claims: Record<string, string>) {
  const m = apiIntegrationManifest({
    name: ID,
    auths: { api: { type: "api_key" } },
  }) as unknown as {
    auths: { api: Record<string, unknown> };
  };
  m.auths.api.identity_claims = identity_claims;
  return m as unknown as Record<string, unknown>;
}
const CAMEL = manifest({ accountId: "$.id" });
const SNAKE = manifest({ account_id: "$.id" });

interface ProblemBody {
  errors?: { field?: string; code?: string; message?: string }[];
}

async function expectRefused(res: Response) {
  expect(res.status).toBe(400);
  const body = (await res.json()) as ProblemBody;
  expect(body.errors?.[0]).toMatchObject({ field: CAMEL_FIELD, code: "invalid_manifest" });
  expect(body.errors?.[0]?.message).toContain("'accountId'");
}

let ctx: TestContext;

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "claimorg" });
});

/** A draft stored before the rule — planted directly, since the routes now refuse it. */
async function seedCamelCaseDraft() {
  await seedPackage({
    id: ID,
    orgId: ctx.orgId,
    type: "integration",
    homeSpaceId: ctx.defaultSpaceId,
    draftManifest: CAMEL,
    draftContent: JSON.stringify(CAMEL, null, 2),
  });
  await uploadPackageFiles("integrations", ctx.orgId, ID, {
    "manifest.json": enc(JSON.stringify(CAMEL, null, 2)),
  });
}

/** A version published before the rule: its archive and its row. */
async function seedCamelCaseVersion(version: string) {
  const m = { ...CAMEL, version };
  const afps = zipSync({ "manifest.json": enc(JSON.stringify(m, null, 2)) });
  await storage.uploadFile(AGENT_PACKAGES_BUCKET, versionZipKey(ID, version), afps);
  await seedPackageVersion({
    packageId: ID,
    version,
    integrity: computeIntegrity(afps),
    artifactSize: afps.length,
    manifest: m,
  });
}

function create(m: Record<string, unknown>) {
  return app.request("/api/packages/integrations", {
    method: "POST",
    headers: authHeaders(ctx, { "Content-Type": "application/json" }),
    body: JSON.stringify({ manifest: m }),
  });
}

describe("reading a stored camelCase manifest", () => {
  it("still serves it", async () => {
    await seedCamelCaseDraft();
    const res = await app.request(`/api/integrations/${ID}`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      manifest: { auths: { api: { identity_claims: Record<string, string> } } };
    };
    expect(body.manifest.auths.api.identity_claims).toEqual({ accountId: "$.id" });
  });
});

describe("writing a camelCase identity claim key", () => {
  it("create refuses it and writes nothing; snake_case is accepted", async () => {
    await expectRefused(await create(CAMEL));
    expect(await db.select({ id: packages.id }).from(packages)).toEqual([]);
    expect((await create(SNAKE)).status).toBe(201);
  });

  it("draft save refuses it and leaves the draft untouched", async () => {
    const created = await create(SNAKE);
    const res = await app.request(`/api/packages/integrations/${ID}`, {
      method: "PATCH",
      headers: authHeaders(ctx, {
        "Content-Type": "application/json",
        ...ifMatch(etagVersion(created)),
      }),
      body: JSON.stringify({ manifest: CAMEL }),
    });
    await expectRefused(res);
    const [row] = await db
      .select({ draftManifest: packages.draftManifest })
      .from(packages)
      .where(eq(packages.id, ID));
    expect(row?.draftManifest).toMatchObject({
      auths: { api: { identity_claims: { account_id: "$.id" } } },
    });
  });

  it("publish refuses to freeze a stored camelCase draft", async () => {
    await seedCamelCaseDraft();
    const res = await app.request(`/api/packages/integrations/${ID}/versions`, {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({ version: "1.0.0" }),
    });
    await expectRefused(res);
    expect(await db.select().from(packageVersions)).toEqual([]);
  });

  it("restoring a published camelCase version refuses it and leaves the draft untouched", async () => {
    expect((await create(SNAKE)).status).toBe(201);
    await seedCamelCaseVersion("2.0.0");
    const res = await app.request(`/api/packages/integrations/${ID}/versions/2.0.0/restore`, {
      method: "POST",
      headers: authHeaders(ctx),
    });
    await expectRefused(res);
    const [row] = await db
      .select({ draftManifest: packages.draftManifest })
      .from(packages)
      .where(eq(packages.id, ID));
    expect(row?.draftManifest).toMatchObject({
      auths: { api: { identity_claims: { account_id: "$.id" } } },
    });
  });

  it("the AFPS import refuses it", async () => {
    const formData = new FormData();
    const zip = zipSync({ "manifest.json": enc(JSON.stringify(CAMEL)) });
    formData.append("file", new File([new Uint8Array(zip)], "claims.afps"));
    const res = await app.request("/api/packages/import", {
      method: "POST",
      headers: authHeaders(ctx),
      body: formData,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    expect(body.errors?.[0]).toMatchObject({ field: CAMEL_FIELD, code: "invalid_manifest" });
    expect(await db.select({ id: packages.id }).from(packages)).toEqual([]);
  });
});
