// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /internal/model-credential/outcome` — the run path's report of what the
 * upstream said about the run's model API key. It feeds the same streak as the
 * platform LLM proxy, always on the run's OWN pinned credential, and ignores a
 * report about a key that is no longer the stored one.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getEnv } from "@appstrate/env";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedOrgModelProviderKey, seedRun } from "../../helpers/seed.ts";
import { signRunToken } from "../../../src/lib/run-token.ts";
import {
  listOrgModelProviderCredentials,
  updateModelProviderCredential,
} from "../../../src/services/model-providers/credentials.ts";

const app = getTestApp();
const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

describe("POST /internal/model-credential/outcome", () => {
  let ctx: TestContext;
  let credentialId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "keyoutcome" });
    await seedAgent({ id: "@keyoutcome/agent", orgId: ctx.orgId, createdBy: ctx.user.id });
    const cred = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      label: "BYOK",
      apiShape: "openai-completions",
      baseUrl: "https://api.openai.test/v1",
      apiKey: "sk-live",
    });
    credentialId = cred.id;
  });

  async function runToken(modelCredentialId: string | null): Promise<string> {
    const run = await seedRun({
      packageId: "@keyoutcome/agent",
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      status: "running",
      modelCredentialId,
    });
    return signRunToken(run.id);
  }

  const report = (token: string, outcome: string, key = "sk-live") =>
    app.request("/internal/model-credential/outcome", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ outcome, key_sha256: sha256(key) }),
    });

  async function flagged(): Promise<boolean> {
    const creds = await listOrgModelProviderCredentials(ctx.orgId);
    return creds.find((c) => c.id === credentialId)!.needs_reconnection === true;
  }

  it("flags the run's key after the threshold of rejections; an acceptance resets the streak", async () => {
    const token = await runToken(credentialId);
    const max = getEnv().INTEGRATION_REFRESH_MAX_FAILURES;
    for (let i = 0; i < max - 1; i++) expect((await report(token, "rejected")).status).toBe(204);
    expect((await report(token, "accepted")).status).toBe(204);
    expect((await report(token, "rejected")).status).toBe(204);
    expect(await flagged()).toBe(false);

    for (let i = 0; i < max - 1; i++) await report(token, "rejected");
    expect(await flagged()).toBe(true);
  });

  it("drops rejections of a key the user has since rotated", async () => {
    const token = await runToken(credentialId);
    await updateModelProviderCredential(ctx.orgId, credentialId, { apiKey: "sk-rotated" });
    for (let i = 0; i < getEnv().INTEGRATION_REFRESH_MAX_FAILURES; i++) {
      await report(token, "rejected", "sk-live");
    }
    expect(await flagged()).toBe(false);
  });

  it("is a no-op for a run with no pinned credential", async () => {
    const token = await runToken(null);
    for (let i = 0; i < getEnv().INTEGRATION_REFRESH_MAX_FAILURES; i++) {
      expect((await report(token, "rejected")).status).toBe(204);
    }
    expect(await flagged()).toBe(false);
  });

  it("rejects a missing token and a body carrying the key instead of its fingerprint", async () => {
    const noAuth = await app.request("/internal/model-credential/outcome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "rejected", key_sha256: sha256("sk-live") }),
    });
    expect(noAuth.status).toBe(401);

    const token = await runToken(credentialId);
    const bad = await app.request("/internal/model-credential/outcome", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "rejected", key_sha256: "sk-live" }),
    });
    expect(bad.status).toBe(400);
  });
});
