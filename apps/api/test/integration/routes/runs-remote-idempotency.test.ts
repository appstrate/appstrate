// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/runs/remote` answers its sink `secret` once, and the idempotency
 * cache stores that 201 for 24 h. The key belongs to the caller that sent it:
 * the same key and body from another principal of the same space is a new
 * request, never a replay of someone else's run and secret.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { assertDbCount } from "../../helpers/assertions.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";
import { buildMinimalZip, uploadPackageZip } from "../../../src/services/package-storage.ts";
import { packageDistTags, runs } from "@appstrate/db/schema";

const app = getTestApp();

const PACKAGE_ID = "@idem-remote/agent";
const VERSION = "1.0.0";

async function seedPublishedAgent(ctx: TestContext) {
  const manifest = {
    name: PACKAGE_ID,
    display_name: "Remote Agent",
    version: VERSION,
    type: "agent",
    description: "Test agent",
    schema_version: "0.1",
    author: "tester",
    timeout: 300,
    dependencies: { skills: {}, mcp_servers: {}, integrations: {} },
  };
  await seedPackage({
    orgId: ctx.orgId,
    id: PACKAGE_ID,
    homeSpaceId: ctx.defaultSpaceId,
    type: "agent",
    draftManifest: manifest,
    draftContent: "Prompt.",
  });
  const versionRow = await seedPackageVersion({
    packageId: PACKAGE_ID,
    version: VERSION,
    integrity: "sha256-test",
    artifactSize: 1024,
    manifest,
  });
  await db
    .insert(packageDistTags)
    .values({ packageId: PACKAGE_ID, tag: "latest", versionId: versionRow.id });
  await uploadPackageZip(PACKAGE_ID, VERSION, buildMinimalZip(manifest, "Prompt."));
  await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, PACKAGE_ID);
}

async function createApiKey(ctx: TestContext, name: string): Promise<string> {
  const res = await app.request("/api/api-keys", {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { key: string }).key;
}

interface RemoteRunCreated {
  id: string;
  secret: string;
}

describe("POST /api/runs/remote — Idempotency-Key is bound to the caller", () => {
  let owner: TestContext;
  let body: string;
  const key = "nightly";

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "idem-remote" });
    await seedPublishedAgent(owner);
    body = JSON.stringify({
      source: { kind: "registry", packageId: PACKAGE_ID, stage: "published", spec: VERSION },
      spaceId: owner.defaultSpaceId,
      input: {},
    });
  });

  function launch(headers: Record<string, string>) {
    return app.request("/api/runs/remote", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": key },
      body,
    });
  }

  it("replays the same member's 201 byte for byte, secret included", async () => {
    const first = await launch(authHeaders(owner));
    expect(first.status).toBe(201);
    const firstText = await first.text();
    expect(((JSON.parse(firstText) as RemoteRunCreated).secret ?? "").length).toBeGreaterThan(0);

    const retry = await launch(authHeaders(owner));
    expect(retry.status).toBe(201);
    expect(retry.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await retry.text()).toBe(firstText);
    await assertDbCount(runs, eq(runs.orgId, owner.orgId), 1);
  });

  it("gives another member of the space a run of their own, never the first secret", async () => {
    const other = await memberContext(owner, "member", "operator");

    const first = await launch(authHeaders(owner));
    expect(first.status).toBe(201);
    const mine = (await first.json()) as RemoteRunCreated;

    const theirs = await launch(authHeaders(other));
    expect(theirs.status).toBe(201);
    expect(theirs.headers.get("Idempotent-Replayed")).toBeNull();
    const theirsText = await theirs.text();
    expect(theirsText).not.toContain(mine.secret);
    expect(theirsText).not.toContain(mine.id);
    await assertDbCount(runs, eq(runs.orgId, owner.orgId), 2);

    // Each caller keeps replaying its own response.
    const ownerRetry = await launch(authHeaders(owner));
    expect(ownerRetry.headers.get("Idempotent-Replayed")).toBe("true");
    expect(((await ownerRetry.json()) as RemoteRunCreated).secret).toBe(mine.secret);
  });

  it("separates two API keys of the same creator, and a key from its creator's session", async () => {
    const keyA = await createApiKey(owner, "key A");
    const keyB = await createApiKey(owner, "key B");

    const viaA = await launch({ Authorization: `Bearer ${keyA}` });
    expect(viaA.status).toBe(201);
    const a = (await viaA.json()) as RemoteRunCreated;

    for (const headers of [{ Authorization: `Bearer ${keyB}` }, authHeaders(owner)]) {
      const res = await launch(headers);
      expect(res.status).toBe(201);
      expect(res.headers.get("Idempotent-Replayed")).toBeNull();
      expect(((await res.json()) as RemoteRunCreated).secret).not.toBe(a.secret);
    }

    const retryA = await launch({ Authorization: `Bearer ${keyA}` });
    expect(retryA.headers.get("Idempotent-Replayed")).toBe("true");
    expect(((await retryA.json()) as RemoteRunCreated).id).toBe(a.id);
    await assertDbCount(runs, eq(runs.orgId, owner.orgId), 3);
  });
});
