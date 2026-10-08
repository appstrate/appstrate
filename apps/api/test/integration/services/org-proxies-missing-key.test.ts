// SPDX-License-Identifier: Apache-2.0

/**
 * An org proxy whose URL is encrypted under a key id the keyring lacks (#1768, #1814): a run
 * must not fall through to the next proxy of the cascade (or none) and leave unproxied, and the
 * proxy list must still render.
 */

import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { orgProxies } from "@appstrate/db/schema";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  createOrgProxy,
  listOrgProxies,
  resolveProxy,
  testProxyConnection,
} from "../../../src/services/org-proxies.ts";
import { initSystemProxies } from "../../../src/services/proxy-registry.ts";

describe("org proxy under a missing kid", () => {
  let ctx: TestContext;
  let proxyId: string;

  beforeAll(() => initSystemProxies());

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "proxykidorg" });
    proxyId = await createOrgProxy(
      ctx.orgId,
      "Egress",
      "http://proxy.example.com:8080",
      ctx.user.id,
    );
    await db
      .update(orgProxies)
      .set({ urlEncrypted: `v1:k0gone:${Buffer.alloc(40).toString("base64")}` })
      .where(eq(orgProxies.id, proxyId));
  });

  it("refuses the launch with a 503 instead of falling through the cascade", async () => {
    const unavailable = { status: 503, code: "encryption_key_unavailable" };
    await expect(resolveProxy(ctx.orgId, "@acme/agent", proxyId)).rejects.toMatchObject(
      unavailable,
    );
    await expect(testProxyConnection(ctx.orgId, proxyId)).rejects.toMatchObject(unavailable);
  });

  it("still lists the proxy, with no URL to show", async () => {
    const listed = (await listOrgProxies(ctx.orgId)).find((p) => p.id === proxyId);
    expect(listed).toMatchObject({ label: "Egress", urlPrefix: "" });
  });
});
