// SPDX-License-Identifier: Apache-2.0

/**
 * Personal model credentials over HTTP: who may create, see, edit and delete a
 * credential owned by one member, what an admin sees, the org policy switch,
 * and the pairing doors that mint subscriptions.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { registerModelProvider } from "../../../src/services/model-providers/registry.ts";
import {
  createApiKeyCredential,
  createOAuthCredential,
} from "../../../src/services/model-providers/credentials.ts";
import { updateOrgSettings } from "../../../src/services/organizations.ts";

const app = getTestApp();

const CREDENTIALS = "/api/model-provider-credentials";
const PAIRINGS = "/api/model-providers-oauth/pairing";
/** Baseline test provider: overridable, so a personal credential on it is refused. */
const CUSTOM_ENDPOINT_PROVIDER = "test-apikey";
/** Fixed endpoint, so a personal key can be created on it. */
const FIXED_KEY_PROVIDER = "test-fixed-apikey";
/** A private endpoint: a probe is refused as BLOCKED_URL before any network call. */
const FIXED_KEY_BASE_URL = "http://10.255.255.9:9/v1";
const OAUTH_PROVIDER = "test-oauth";

interface CredentialRow {
  id: string;
  label: string;
  source: string;
  owner_type: "org" | "user";
  owner_id: string | null;
  owner_name: string | null;
}

function jsonHeaders(ctx: TestContext): Record<string, string> {
  return authHeaders(ctx, { "Content-Type": "application/json" });
}

function createCredential(ctx: TestContext, body: Record<string, unknown>) {
  return app.request(CREDENTIALS, {
    method: "POST",
    headers: jsonHeaders(ctx),
    body: JSON.stringify(body),
  });
}

async function listCredentials(ctx: TestContext): Promise<CredentialRow[]> {
  const res = await app.request(CREDENTIALS, { headers: authHeaders(ctx) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: CredentialRow[] }).data;
}

describe("personal model credentials — routes", () => {
  let admin: TestContext;
  let member: TestContext;
  let otherMember: TestContext;
  let guest: TestContext;

  beforeEach(async () => {
    await truncateAll();
    seedTestModelProviders();
    // Every baseline provider is overridable; this one has a fixed endpoint.
    registerModelProvider({
      providerId: FIXED_KEY_PROVIDER,
      displayName: "Fixed Key Provider",
      iconUrl: "openai",
      apiShape: "openai-completions",
      defaultBaseUrl: FIXED_KEY_BASE_URL,
      baseUrlOverridable: false,
      authMode: "api_key",
      featuredModels: [],
    });
    admin = await createTestContext();
    member = await memberContext(admin, "member");
    otherMember = await memberContext(admin, "member");
    guest = await memberContext(admin, "guest");
  });

  describe("creating", () => {
    it("a member creates a personal api-key credential owned by itself", async () => {
      const res = await createCredential(member, {
        providerId: FIXED_KEY_PROVIDER,
        api_key: "sk-member-personal",
        owner_type: "user",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as CredentialRow;
      expect(body.owner_type).toBe("user");
      expect(body.owner_id).toBe(member.user.id);
      expect(body.owner_name).toBe(member.user.name);
    });

    it("a guest creates a personal credential", async () => {
      const res = await createCredential(guest, {
        providerId: FIXED_KEY_PROVIDER,
        api_key: "sk-guest-personal",
        owner_type: "user",
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as CredentialRow).owner_id).toBe(guest.user.id);
    });

    it("a member cannot create an organization credential", async () => {
      const implicit = await createCredential(member, {
        providerId: FIXED_KEY_PROVIDER,
        api_key: "sk-member-org",
      });
      expect(implicit.status).toBe(403);

      const explicit = await createCredential(member, {
        providerId: FIXED_KEY_PROVIDER,
        api_key: "sk-member-org",
        owner_type: "org",
      });
      expect(explicit.status).toBe(403);
      expect(await listCredentials(admin)).toHaveLength(0);
    });

    it("a personal credential on a custom-endpoint provider is refused with 400", async () => {
      const res = await createCredential(member, {
        providerId: CUSTOM_ENDPOINT_PROVIDER,
        api_key: "sk-member-custom",
        owner_type: "user",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("personal_credential_custom_endpoint");
    });

    it("the org policy off refuses personal credentials with 403, not organization ones", async () => {
      await updateOrgSettings(admin.orgId, { personal_model_credentials: false });

      const personal = await createCredential(member, {
        providerId: FIXED_KEY_PROVIDER,
        api_key: "sk-member-off",
        owner_type: "user",
      });
      expect(personal.status).toBe(403);
      expect(((await personal.json()) as { code: string }).code).toBe(
        "personal_model_credentials_disabled",
      );

      const org = await createCredential(admin, {
        providerId: FIXED_KEY_PROVIDER,
        api_key: "sk-org-still-on",
      });
      expect(org.status).toBe(201);
    });
  });

  describe("visibility", () => {
    it("a member lists only its own credentials, never the organization's", async () => {
      await createApiKeyCredential({
        orgId: admin.orgId,
        userId: admin.user.id,
        label: "Org key",
        providerId: FIXED_KEY_PROVIDER,
        apiKey: "sk-org",
      });
      await createApiKeyCredential({
        orgId: admin.orgId,
        userId: member.user.id,
        label: "Member key",
        providerId: FIXED_KEY_PROVIDER,
        apiKey: "sk-member",
        ownerUserId: member.user.id,
      });
      await createApiKeyCredential({
        orgId: admin.orgId,
        userId: otherMember.user.id,
        label: "Other member key",
        providerId: FIXED_KEY_PROVIDER,
        apiKey: "sk-other",
        ownerUserId: otherMember.user.id,
      });

      const labels = (await listCredentials(member)).map((c) => c.label);
      expect(labels).toEqual(["Member key"]);
    });

    it("the admin sees every credential with its owner fields", async () => {
      await createApiKeyCredential({
        orgId: admin.orgId,
        userId: admin.user.id,
        label: "Org key",
        providerId: FIXED_KEY_PROVIDER,
        apiKey: "sk-org",
      });
      await createApiKeyCredential({
        orgId: admin.orgId,
        userId: member.user.id,
        label: "Member key",
        providerId: FIXED_KEY_PROVIDER,
        apiKey: "sk-member",
        ownerUserId: member.user.id,
      });

      const rows = await listCredentials(admin);
      const org = rows.find((c) => c.label === "Org key");
      const personal = rows.find((c) => c.label === "Member key");
      expect(org).toMatchObject({ owner_type: "org", owner_id: null, owner_name: null });
      expect(personal).toMatchObject({
        owner_type: "user",
        owner_id: member.user.id,
        owner_name: member.user.name,
      });
    });
  });

  describe("editing and deleting", () => {
    it("a member edits its own personal credential", async () => {
      const id = await createApiKeyCredential({
        orgId: admin.orgId,
        userId: member.user.id,
        label: "Before",
        providerId: FIXED_KEY_PROVIDER,
        apiKey: "sk-member",
        ownerUserId: member.user.id,
      });
      const res = await app.request(`${CREDENTIALS}/${id}`, {
        method: "PATCH",
        headers: jsonHeaders(member),
        body: JSON.stringify({ label: "After" }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as CredentialRow).label).toBe("After");
    });

    it("a member cannot edit or delete another member's credential: 404, and it survives", async () => {
      const id = await createApiKeyCredential({
        orgId: admin.orgId,
        userId: otherMember.user.id,
        label: "Other member key",
        providerId: FIXED_KEY_PROVIDER,
        apiKey: "sk-other",
        ownerUserId: otherMember.user.id,
      });

      const patch = await app.request(`${CREDENTIALS}/${id}`, {
        method: "PATCH",
        headers: jsonHeaders(member),
        body: JSON.stringify({ label: "Hijacked" }),
      });
      expect(patch.status).toBe(404);

      const del = await app.request(`${CREDENTIALS}/${id}`, {
        method: "DELETE",
        headers: authHeaders(member),
      });
      expect(del.status).toBe(404);

      const remaining = await listCredentials(otherMember);
      expect(remaining.map((c) => c.label)).toEqual(["Other member key"]);
    });

    it("a member cannot edit or delete an organization credential: 404", async () => {
      const id = await createApiKeyCredential({
        orgId: admin.orgId,
        userId: admin.user.id,
        label: "Org key",
        providerId: FIXED_KEY_PROVIDER,
        apiKey: "sk-org",
      });

      const patch = await app.request(`${CREDENTIALS}/${id}`, {
        method: "PATCH",
        headers: jsonHeaders(member),
        body: JSON.stringify({ label: "Renamed" }),
      });
      expect(patch.status).toBe(404);

      const del = await app.request(`${CREDENTIALS}/${id}`, {
        method: "DELETE",
        headers: authHeaders(member),
      });
      expect(del.status).toBe(404);
    });

    it("the admin deletes a member's personal credential (break-glass)", async () => {
      const id = await createApiKeyCredential({
        orgId: admin.orgId,
        userId: member.user.id,
        label: "Member key",
        providerId: FIXED_KEY_PROVIDER,
        apiKey: "sk-member",
        ownerUserId: member.user.id,
      });

      const res = await app.request(`${CREDENTIALS}/${id}`, {
        method: "DELETE",
        headers: authHeaders(admin),
      });
      expect(res.status).toBe(204);
      expect(await listCredentials(admin)).toHaveLength(0);
    });

    it("a member deletes its own personal credential", async () => {
      const id = await createApiKeyCredential({
        orgId: admin.orgId,
        userId: member.user.id,
        label: "Member key",
        providerId: FIXED_KEY_PROVIDER,
        apiKey: "sk-member",
        ownerUserId: member.user.id,
      });

      const res = await app.request(`${CREDENTIALS}/${id}`, {
        method: "DELETE",
        headers: authHeaders(member),
      });
      expect(res.status).toBe(204);
    });
  });

  describe("testing a credential", () => {
    const probe = (ctx: TestContext, id: string) =>
      app.request(`${CREDENTIALS}/${id}/test`, { method: "POST", headers: authHeaders(ctx) });

    const orgKey = () =>
      createApiKeyCredential({
        orgId: admin.orgId,
        userId: admin.user.id,
        label: "Org key",
        providerId: FIXED_KEY_PROVIDER,
        apiKey: "sk-org",
      });

    it("a member with connect gets 404 testing an organization credential", async () => {
      const res = await probe(member, await orgKey());
      expect(res.status).toBe(404);
    });

    it("an admin tests an organization credential", async () => {
      const res = await probe(admin, await orgKey());
      expect(res.status).toBe(200);
      expect(((await res.json()) as { error: string }).error).toBe("BLOCKED_URL");
    });

    it("a member tests its own personal credential", async () => {
      const id = await createApiKeyCredential({
        orgId: admin.orgId,
        userId: member.user.id,
        label: "Member key",
        providerId: FIXED_KEY_PROVIDER,
        apiKey: "sk-member",
        ownerUserId: member.user.id,
      });
      const res = await probe(member, id);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { error: string }).error).toBe("BLOCKED_URL");
    });

    it("a member gets 404 testing another member's personal credential", async () => {
      const id = await createApiKeyCredential({
        orgId: admin.orgId,
        userId: otherMember.user.id,
        label: "Other member key",
        providerId: FIXED_KEY_PROVIDER,
        apiKey: "sk-other",
        ownerUserId: otherMember.user.id,
      });
      expect((await probe(member, id)).status).toBe(404);
    });

    it("the inline test treats an organization credential as absent for a member", async () => {
      const id = await orgKey();
      const inline = (ctx: TestContext) =>
        app.request(`${CREDENTIALS}/test`, {
          method: "POST",
          headers: jsonHeaders(ctx),
          body: JSON.stringify({
            providerId: FIXED_KEY_PROVIDER,
            base_url: FIXED_KEY_BASE_URL,
            credentialId: id,
          }),
        });

      // No key of its own: the organization credential is not usable by a member.
      const memberRes = await inline(member);
      expect(memberRes.status).toBe(400);
      expect(((await memberRes.json()) as { param: string }).param).toBe("api_key");

      const adminRes = await inline(admin);
      expect(adminRes.status).toBe(200);
      expect(((await adminRes.json()) as { error: string }).error).toBe("BLOCKED_URL");
    });
  });

  describe("subscription pairings", () => {
    it("a member mints a pairing; another member cannot read or cancel it", async () => {
      const mint = await app.request(PAIRINGS, {
        method: "POST",
        headers: jsonHeaders(member),
        body: JSON.stringify({ providerId: OAUTH_PROVIDER }),
      });
      expect(mint.status).toBe(200);
      const { id } = (await mint.json()) as { id: string };

      const foreignRead = await app.request(`${PAIRINGS}/${id}`, {
        headers: authHeaders(otherMember),
      });
      expect(foreignRead.status).toBe(404);

      await app.request(`${PAIRINGS}/${id}`, {
        method: "DELETE",
        headers: authHeaders(otherMember),
      });
      const ownRead = await app.request(`${PAIRINGS}/${id}`, {
        headers: authHeaders(member),
      });
      expect(ownRead.status).toBe(200);
      expect(((await ownRead.json()) as { status: string }).status).toBe("pending");
    });

    it("the org policy off refuses a pairing mint with 403", async () => {
      await updateOrgSettings(admin.orgId, { personal_model_credentials: false });
      const res = await app.request(PAIRINGS, {
        method: "POST",
        headers: jsonHeaders(member),
        body: JSON.stringify({ providerId: OAUTH_PROVIDER }),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe(
        "personal_model_credentials_disabled",
      );
    });

    it("a reconnect pairing must target the caller's own subscription", async () => {
      const subscriptionId = await createOAuthCredential({
        orgId: admin.orgId,
        userId: otherMember.user.id,
        label: "Other subscription",
        providerId: OAUTH_PROVIDER,
        accessToken: "at-other",
        refreshToken: "rt-other",
      });

      const foreign = await app.request(PAIRINGS, {
        method: "POST",
        headers: jsonHeaders(member),
        body: JSON.stringify({ providerId: OAUTH_PROVIDER, credentialId: subscriptionId }),
      });
      expect(foreign.status).toBe(404);

      const ownId = await createOAuthCredential({
        orgId: admin.orgId,
        userId: member.user.id,
        label: "Own subscription",
        providerId: OAUTH_PROVIDER,
        accessToken: "at-own",
        refreshToken: "rt-own",
      });
      const own = await app.request(PAIRINGS, {
        method: "POST",
        headers: jsonHeaders(member),
        body: JSON.stringify({ providerId: OAUTH_PROVIDER, credentialId: ownId }),
      });
      expect(own.status).toBe(200);
    });
  });
});
