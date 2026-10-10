// SPDX-License-Identifier: Apache-2.0

/**
 * Who pays a model call made with an instance token (#1875).
 *
 * The CLI and the MCP instance token authenticate the user themselves
 * (`authMethod: "oauth2-instance"`, `principalKind: "user"`), so a member's
 * personal credential serves their calls exactly as it serves their session:
 * the door does not change the rule. Real instance JWTs, verified by the real
 * strategy.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { _resetCacheForTesting } from "@appstrate/env";
import { orgModels } from "@appstrate/db/schema";
import { db, truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  addOrgMember,
  createTestOrg,
  createTestUser,
} from "../../../../../../test/helpers/auth.ts";
import { seedOrgModelProviderKey, seedSpaceMember } from "../../../../../../test/helpers/seed.ts";
import {
  createFakeOrchestrator,
  inlineAgentManifest,
  waitForRunPipelineSettled,
} from "../../../../../../test/helpers/run-connection-fixtures.ts";

const originalAppUrl = process.env.APP_URL;
let jwksServer: ReturnType<typeof Bun.serve> | null = null;
let privateKey: jose.CryptoKey;
let publicJwk: jose.JWK;
const kid = "personal-model-credential-test-key-1";
let app: Awaited<ReturnType<typeof import("../../../../../../test/helpers/app.ts").getTestApp>>;

async function startJwksServer() {
  const { publicKey, privateKey: priv } = await jose.generateKeyPair("ES256", {
    extractable: true,
  });
  privateKey = priv;
  const jwk = await jose.exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = "ES256";
  jwk.use = "sig";
  publicJwk = jwk;
  jwksServer = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/api/auth/jwks") return Response.json({ keys: [jwk] });
      return new Response("not found", { status: 404 });
    },
  });
  process.env.APP_URL = `http://127.0.0.1:${jwksServer.port}`;
  _resetCacheForTesting();
}

async function mintInstanceToken(sub: string, clientId: string): Promise<string> {
  return new jose.SignJWT({
    azp: clientId,
    actor_type: "user",
    email: "member@example.com",
    name: "Member",
    scope: "openid profile email",
  })
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(`${process.env.APP_URL!}/api/auth`)
    .setAudience(process.env.APP_URL!)
    .setIssuedAt()
    .setExpirationTime("2m")
    .setSubject(sub)
    .sign(privateKey);
}

beforeAll(async () => {
  await startJwksServer();
  const { getTestApp } = await import("../../../../../../test/helpers/app.ts");
  const { default: oidcModule } = await import("../../../index.ts");
  const { overrideJwks } = await import("../../../services/enduser-token.ts");
  const { _setOrchestratorForTesting } =
    await import("../../../../../services/orchestrator/index.ts");
  overrideJwks(async () => ({ keys: [publicJwk] }));
  _setOrchestratorForTesting(createFakeOrchestrator());
  app = getTestApp({ modules: [oidcModule] });
});

afterAll(async () => {
  const { _setOrchestratorForTesting } =
    await import("../../../../../services/orchestrator/index.ts");
  _setOrchestratorForTesting(null);
  jwksServer?.stop(true);
  if (originalAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = originalAppUrl;
  _resetCacheForTesting();
});

describe("personal model credentials — instance token", () => {
  let orgId: string;
  let spaceId: string;
  let headers: Record<string, string>;
  let personalKeyId: string;

  beforeEach(async () => {
    await truncateAll();
    const owner = await createTestUser();
    const created = await createTestOrg(owner.id);
    orgId = created.org.id;
    spaceId = created.defaultSpaceId;
    const member = await createTestUser();
    await addOrgMember(orgId, member.id, "member");
    await seedSpaceMember({ spaceId, userId: member.id, presetRole: "builder" });

    // An org default served by nothing but each member's own credential.
    const [model] = await db
      .insert(orgModels)
      .values({
        orgId,
        label: "Shared GPT",
        modelId: "gpt-5.5",
        providerId: "openai",
        credentialId: null,
        aliased: false,
        source: "custom",
        createdBy: owner.id,
      })
      .returning({ id: orgModels.id });
    const { setDefaultModel } = await import("../../../../../services/org-models.ts");
    await setDefaultModel(orgId, model!.id);
    personalKeyId = (
      await seedOrgModelProviderKey({
        orgId,
        createdBy: member.id,
        ownerUserId: member.id,
        label: "member-key",
        providerId: "openai",
        apiKey: "sk-personal-member",
      })
    ).id;

    const { ensureInstanceClient } = await import("../../../services/oauth-admin.ts");
    const clientId = await ensureInstanceClient("http://localhost:3000");
    headers = {
      Authorization: `Bearer ${await mintInstanceToken(member.id, clientId)}`,
      "X-Org-Id": orgId,
      "X-Space-Id": spaceId,
    };
  });

  afterEach(waitForRunPipelineSettled);

  it("lists the model as paid by the caller", async () => {
    const res = await app.request("/api/models", { headers });
    expect(res.status, await res.clone().text()).toBe(200);
    const { data } = (await res.json()) as {
      data: Array<{ label: string; billed_to: string | null }>;
    };
    expect(data.find((m) => m.label === "Shared GPT")?.billed_to).toBe("user");
  });

  it("launches a run on the member's own credential", async () => {
    const res = await app.request("/api/runs/inline", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ manifest: inlineAgentManifest(), prompt: "do the thing" }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const detail = await app.request(`/api/runs/${id}`, { headers });
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { modelCredentialId: string | null }).modelCredentialId).toBe(
      personalKeyId,
    );
  });
});
