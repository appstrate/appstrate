// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { assertDbCount } from "../../helpers/assertions.ts";
import { endUsers } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";

const app = getTestApp();

describe("Idempotency integration (end-users)", () => {
  let ctx: TestContext;
  let apiKeyRaw: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });

    const res = await app.request("/api/api-keys", {
      method: "POST",
      headers: {
        Cookie: ctx.cookie,
        "X-Org-Id": ctx.orgId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Idempotency Test Key",
        applicationId: ctx.defaultAppId,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string };
    apiKeyRaw = body.key;
  });

  function postEndUser(name: string, idempotencyKey?: string) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKeyRaw}`,
      "Content-Type": "application/json",
    };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    return app.request("/api/end-users", {
      method: "POST",
      headers,
      body: JSON.stringify({ name }),
    });
  }

  it("creates only one record when same key is sent twice", async () => {
    const res1 = await postEndUser("Alice", "idem-1");
    expect(res1.status).toBe(201);

    const res2 = await postEndUser("Alice", "idem-1");
    expect(res2.status).toBe(201);
    expect(res2.headers.get("Idempotent-Replayed")).toBe("true");

    // Verify only one record in DB
    await assertDbCount(endUsers, eq(endUsers.orgId, ctx.orgId), 1);
  });

  it("returns 422 when same key with different body", async () => {
    const res1 = await postEndUser("Alice", "idem-2");
    expect(res1.status).toBe(201);

    const res2 = await postEndUser("Bob", "idem-2");
    expect(res2.status).toBe(422);
    const body = (await res2.json()) as { code: string };
    expect(body.code).toBe("idempotency_conflict");

    // Still only one record
    await assertDbCount(endUsers, eq(endUsers.orgId, ctx.orgId), 1);
  });

  it("creates separate records with different keys", async () => {
    const res1 = await postEndUser("Alice", "idem-a");
    expect(res1.status).toBe(201);

    const res2 = await postEndUser("Bob", "idem-b");
    expect(res2.status).toBe(201);
    expect(res2.headers.get("Idempotent-Replayed")).toBeNull();

    await assertDbCount(endUsers, eq(endUsers.orgId, ctx.orgId), 2);
  });

  it("works normally without idempotency key", async () => {
    const res1 = await postEndUser("Alice");
    expect(res1.status).toBe(201);

    const res2 = await postEndUser("Bob");
    expect(res2.status).toBe(201);

    await assertDbCount(endUsers, eq(endUsers.orgId, ctx.orgId), 2);
  });
});
