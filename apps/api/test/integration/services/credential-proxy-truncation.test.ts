// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for response-size capping in the credential-proxy
 * service (`proxyCall` + `maxResponseBytes`).
 *
 * Regression guard for the getter-snapshot bug: `proxyCall` used to
 * destructure `truncated` from the capping helper BEFORE the capped stream
 * was consumed, snapshotting a static `false`. The route then never set
 * `X-Truncated: true` on capped non-streaming responses. `truncated` must be
 * a live getter that reflects the final state once the body is drained.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { applicationPackages, integrationConnections } from "@appstrate/db/schema";
import { encryptCredentials } from "@appstrate/connect";
import { proxyCall } from "../../../src/services/credential-proxy/core.ts";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

const PACKAGE_ID = "@cptruncorg/gmail";

async function seedIntegrationWithConnection(ctx: TestContext): Promise<void> {
  await seedPackage({
    id: PACKAGE_ID,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: localIntegrationManifest({
      name: PACKAGE_ID,
      displayName: "Gmail",
      description: "Gmail integration",
      auths: {
        api: {
          type: "api_key",
          authorizedUris: ["https://gmail.googleapis.com/**"],
          delivery: httpHeaderDelivery({
            name: "Authorization",
            prefix: "Bearer ",
            field: "api_key",
          }),
        },
      },
    }),
  });
  await db.insert(applicationPackages).values({
    applicationId: ctx.defaultAppId,
    packageId: PACKAGE_ID,
    config: {},
  });
  await db.insert(integrationConnections).values({
    integrationId: PACKAGE_ID,
    authKey: "api",
    accountId: "acct-1",
    applicationId: ctx.defaultAppId,
    userId: ctx.user.id,
    credentialsEncrypted: encryptCredentials({ api_key: "ya29.live-token" }),
    scopesGranted: [],
    sharedWithOrg: false,
  });
}

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<number> {
  if (!stream) return 0;
  const reader = stream.getReader();
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) total += value.byteLength;
  }
  return total;
}

describe("proxyCall — response-size capping (integration-backed)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "cptruncorg" });
    await seedIntegrationWithConnection(ctx);
  });

  it("flags truncated=true once the capped body is consumed when the cap is exceeded", async () => {
    const fakeFetch = (() =>
      Promise.resolve(
        new Response(new Uint8Array(100), {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
      )) as unknown as typeof fetch;

    const res = await proxyCall({
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      integrationId: PACKAGE_ID,
      method: "GET",
      target: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      headers: {},
      maxResponseBytes: 10,
      fetch: fakeFetch,
    });

    // Pre-consumption the flag is necessarily false; the bug was reading it
    // here and snapshotting that value into the result.
    expect(res.status).toBe(200);
    const emitted = await drain(res.body);
    expect(emitted).toBe(10);
    // Live getter must now reflect the truncation that happened mid-stream.
    expect(res.truncated).toBe(true);
  });

  it("leaves truncated=false when the body fits under the cap", async () => {
    const fakeFetch = (() =>
      Promise.resolve(
        new Response(new Uint8Array(5), {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
      )) as unknown as typeof fetch;

    const res = await proxyCall({
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      integrationId: PACKAGE_ID,
      method: "GET",
      target: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      headers: {},
      maxResponseBytes: 10,
      fetch: fakeFetch,
    });

    const emitted = await drain(res.body);
    expect(emitted).toBe(5);
    expect(res.truncated).toBe(false);
  });
});
