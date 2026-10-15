// SPDX-License-Identifier: Apache-2.0

/**
 * Access verdicts the SPA used to recompute, served by the server (#1990):
 *   - `GET /api/org-roles` — each org role's grants, module contributions included;
 *   - `serves_model_ids` on a personal model credential — `servesModel`'s answer;
 *   - `activation` on a library row — what the activation routes would answer.
 * Each verdict is checked against the rule that decides it on the server, with a control that
 * differs by exactly the fact under test.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { ORG_ROLES } from "@appstrate/core/permissions";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedAgent,
  seedOrgModel,
  seedPackageShare,
  seedSpace,
  seedSpacePackage,
} from "../../helpers/seed.ts";
import { orgPermissions } from "../../../src/lib/permissions.ts";
import { createApiKeyCredential } from "../../../src/services/model-providers/credentials.ts";
import { servesModel } from "../../../src/services/model-providers/credential-chain.ts";
import { registerModelProvider } from "../../../src/services/model-providers/registry.ts";

/** A fixed-endpoint key of Anthropic's family: a personal credential may be made on it. */
const FIXED_ANTHROPIC = "test-fixed-anthropic";

const app = getTestApp();

let owner: TestContext;

beforeEach(async () => {
  await truncateAll();
  owner = await createTestContext({ orgSlug: "projections" });
});

describe("GET /api/org-roles", () => {
  it("serves each role's grants as the API enforces them, to any member", async () => {
    const member = await memberContext(owner, "member");
    const res = await app.request("/api/org-roles", { headers: authHeaders(member) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { role: string; permissions: string[] }[] };
    expect(body.data.map((entry) => entry.role)).toEqual([...ORG_ROLES]);
    for (const entry of body.data) {
      expect(entry.permissions).toEqual(
        [...orgPermissions(entry.role as (typeof ORG_ROLES)[number])].sort(),
      );
    }
    const of = (role: string) =>
      new Set(body.data.find((entry) => entry.role === role)!.permissions);
    expect(of("owner").has("org:delete")).toBe(true);
    // CONTROL: the same permission, withheld from an admin.
    expect(of("admin").has("org:delete")).toBe(false);
  });
});

describe("serves_model_ids", () => {
  it("lists the unbound models a personal credential pays for, and nothing on an org one", async () => {
    registerModelProvider({
      providerId: FIXED_ANTHROPIC,
      catalogProviderId: "anthropic",
      displayName: "Fixed Anthropic",
      iconUrl: "anthropic",
      apiShape: "anthropic-messages",
      defaultBaseUrl: "https://api.anthropic.com",
      baseUrlOverridable: false,
      authMode: "api_key",
      featuredModels: [],
    });
    const member = await memberContext(owner, "member");
    const personal = await createApiKeyCredential({
      orgId: owner.orgId,
      userId: member.user.id,
      ownerUserId: member.user.id,
      label: "Ma clé",
      providerId: FIXED_ANTHROPIC,
      apiKey: "sk-ant-personal",
    });
    const orgKey = await createApiKeyCredential({
      orgId: owner.orgId,
      userId: owner.user.id,
      ownerUserId: null,
      label: "Clé équipe",
      providerId: FIXED_ANTHROPIC,
      apiKey: "sk-ant-org",
    });
    const unbound = await seedOrgModel({
      orgId: owner.orgId,
      providerId: FIXED_ANTHROPIC,
      modelId: "claude-sonnet-4-5",
      credentialId: null,
    });
    const otherService = await seedOrgModel({
      orgId: owner.orgId,
      providerId: "openai",
      modelId: "gpt-4o-mini",
      credentialId: null,
    });
    await seedOrgModel({ orgId: owner.orgId, modelId: "claude-sonnet-4-5", credentialId: orgKey });

    const res = await app.request("/api/model-provider-credentials", {
      headers: authHeaders(owner),
    });
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { data: { id: string; serves_model_ids: string[] }[] })
      .data;
    const served = (id: string) => rows.find((row) => row.id === id)?.serves_model_ids;
    // The server's own rule decides, model by model.
    expect(servesModel(FIXED_ANTHROPIC, unbound)).toBe(true);
    expect(servesModel(FIXED_ANTHROPIC, otherService)).toBe(false);
    expect(served(personal)).toEqual([unbound.id]);
    // An organization key's models name it as their credential instead.
    expect(served(orgKey)).toEqual([]);
  });
});

describe("library activation verdicts", () => {
  const AGENT = "@projections/worker";

  /** The default space's own library page: what a member reads of it. */
  async function libraryRow(ctx: TestContext) {
    const res = await app.request(`/api/spaces/${owner.defaultSpaceId}/library`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      packages: {
        agent: {
          id: string;
          activation: { space_id: string; activate: string; deactivate: string }[];
        }[];
      };
    };
    return body.packages.agent.find((row) => row.id === AGENT)!;
  }
  const cellOf = (row: Awaited<ReturnType<typeof libraryRow>>, spaceId: string) =>
    row.activation.find((cell) => cell.space_id === spaceId);

  beforeEach(async () => {
    await seedAgent({
      id: AGENT,
      orgId: owner.orgId,
      createdBy: owner.user.id,
      homeSpaceId: owner.defaultSpaceId,
      draftManifest: { name: AGENT, version: "0.1.0", type: "agent", display_name: "Worker" },
    });
    await seedSpacePackage(owner.defaultSpaceId, AGENT);
  });

  it("allows an owner in the package's home", async () => {
    const row = await libraryRow(owner);
    expect(row.activation).toEqual([
      { space_id: owner.defaultSpaceId, activate: "allowed", deactivate: "allowed" },
    ]);
  });

  it("blames the share right where a package is not placed and its home is not the caller's to share", async () => {
    // Homed in a member's PERSONAL space, offered to the default one: the org owner reads it
    // there, may not share out of somebody's personal space, and so cannot place it elsewhere.
    const member = await memberContext(owner, "member");
    const personal = await seedSpace({
      orgId: owner.orgId,
      name: "Mon espace",
      visibility: "private",
      ownerUserId: member.user.id,
    });
    const team = await seedSpace({ orgId: owner.orgId, name: "Team" });
    const PRIVATE = "@projections/private";
    await seedAgent({
      id: PRIVATE,
      orgId: owner.orgId,
      createdBy: member.user.id,
      homeSpaceId: personal.id,
      draftManifest: { name: PRIVATE, version: "0.1.0", type: "agent", display_name: "P" },
    });
    await seedPackageShare(owner.defaultSpaceId, PRIVATE, member.user.id);

    const res = await app.request("/api/library", { headers: authHeaders(owner) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      packages: {
        agent: {
          id: string;
          activation: { space_id: string; activate: string; deactivate: string }[];
        }[];
      };
    };
    const row = body.packages.agent.find((entry) => entry.id === PRIVATE)!;
    const cell = (spaceId: string) => row.activation.find((entry) => entry.space_id === spaceId);
    expect(cell(team.id)).toMatchObject({ activate: "not_shareable" });
    // CONTROL: where it is placed, the owner's grant decides, and it holds.
    expect(cell(owner.defaultSpaceId)).toMatchObject({
      activate: "allowed",
      deactivate: "allowed",
    });
  });

  it("names the missing grant for a member, by preset", async () => {
    // A `viewer` holds no activation grant in the default space; the package is homed there.
    const viewer = await memberContext(owner, "member", "viewer");
    const row = await libraryRow(viewer);
    expect(cellOf(row, owner.defaultSpaceId)).toMatchObject({
      activate: "forbidden",
      deactivate: "forbidden",
    });
    // CONTROL: a `builder` there may switch it.
    const builder = await memberContext(owner, "member", "builder");
    expect(cellOf(await libraryRow(builder), owner.defaultSpaceId)).toMatchObject({
      activate: "allowed",
      deactivate: "allowed",
    });
  });
});
