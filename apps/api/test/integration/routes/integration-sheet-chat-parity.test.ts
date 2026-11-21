// SPDX-License-Identifier: Apache-2.0

/**
 * The integration sheet (`GET /api/integrations/{id}`) and the chat's context
 * (`GET /api/me/context`, MCP `get_me`) tell ONE story about the same
 * (integration, space, caller): is it available here, and which connections
 * does the caller hold there. Each step compares the two doors to each other.
 *
 * Reference scenario: an owner offers an integration to the organization and
 * holds one connection in her space; a colleague works in another space.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  authHeaders,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedOrgOffer,
  seedPackage,
  seedPublishedVersion,
  seedSpace,
  seedSpaceMember,
  seedSpacePackage,
} from "../../helpers/seed.ts";
import { db } from "@appstrate/db/client";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import {
  httpHeaderDelivery,
  localIntegrationManifest,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();

const INTEGRATION = "@parity/crm";

let olivia: TestContext;
/** The colleague's headers, acting in his own team space. */
let colleague: { id: string; headers: Record<string, string> };
let connectionId: string;
let teamSpaceId: string;

interface SheetConnection {
  id: string;
  account_id: string;
  owner_id: string;
}
interface ContextConnection {
  id: string;
  label: string;
  account_id: string;
  owned_by_actor: boolean;
}

async function sheet(headers: Record<string, string>) {
  const res = await app.request(`/api/integrations/${INTEGRATION}`, { headers });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as {
    active: boolean;
    availability: { via: string; state: string };
    auths: Array<{ auth_key: string; connections: SheetConnection[] }>;
  };
  return {
    active: body.active,
    availability: body.availability,
    connections: body.auths.flatMap((auth) => auth.connections),
  };
}

async function chat(headers: Record<string, string>) {
  const res = await app.request("/api/me/context", { headers });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as {
    connections: Array<{
      integration_package_id: string;
      active: boolean;
      via: string | null;
      connections: ContextConnection[];
    }>;
  };
  return body.connections.find((entry) => entry.integration_package_id === INTEGRATION);
}

beforeEach(async () => {
  await truncateAll();
  olivia = await createTestContext();
  teamSpaceId = (await seedSpace({ orgId: olivia.orgId, name: "Equipe" })).id;
  // Homed elsewhere, so the offer is what places it in Olivia's and the colleague's spaces.
  const catalogueSpaceId = (await seedSpace({ orgId: olivia.orgId, name: "Catalogue" })).id;

  const user = await createTestUser();
  await addOrgMember(olivia.orgId, user.id, "member");
  await seedSpaceMember({ spaceId: teamSpaceId, userId: user.id, presetRole: "builder" });
  colleague = {
    id: user.id,
    headers: { Cookie: user.cookie, "X-Org-Id": olivia.orgId, "X-Space-Id": teamSpaceId },
  };

  await seedPackage({
    id: INTEGRATION,
    orgId: olivia.orgId,
    type: "integration",
    homeSpaceId: catalogueSpaceId,
    draftManifest: localIntegrationManifest({
      name: INTEGRATION,
      displayName: "CRM",
      auths: {
        primary: {
          type: "api_key",
          authorizedUris: ["https://example.test/**"],
          delivery: httpHeaderDelivery({
            name: "Authorization",
            prefix: "Bearer ",
            field: "api_key",
          }),
        },
      },
    }) as unknown as Record<string, unknown>,
  });
  await seedOrgOffer(olivia.orgId, INTEGRATION);
  // Org-wide (`space_id` null): a connection confined to one space cannot be shared out of it.
  const [connection] = await db
    .insert(integrationConnections)
    .values({
      integrationId: INTEGRATION,
      authKey: "primary",
      accountId: "olivia@example.test",
      orgId: olivia.orgId,
      spaceId: null,
      originSpaceId: olivia.defaultSpaceId,
      userId: olivia.user.id,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "secret-value" } }),
      scopesGranted: [],
      label: "Mon CRM",
    })
    .returning({ id: integrationConnections.id });
  connectionId = connection!.id;
});

describe("the sheet and the chat agree on an offered integration and its connections", () => {
  it("both show it active to its owner, with her connection as hers", async () => {
    const headers = authHeaders(olivia);
    const [fromSheet, fromChat] = [await sheet(headers), await chat(headers)];

    expect(fromSheet.availability).toMatchObject({ via: "organization", state: "active" });
    expect(fromSheet.active).toBe(true);
    expect(fromChat?.active).toBe(fromSheet.active);
    expect(fromChat?.via).toBe(fromSheet.availability.via);

    expect(fromSheet.connections.map((c) => c.id)).toEqual([connectionId]);
    expect(fromChat?.connections.map((c) => c.id)).toEqual(fromSheet.connections.map((c) => c.id));
    expect(fromChat?.connections[0]).toMatchObject({
      label: "Mon CRM",
      account_id: fromSheet.connections[0]!.account_id,
      owned_by_actor: true,
    });
    expect(fromSheet.connections[0]!.owner_id).toBe(olivia.user.id);
  });

  it("both show it active to the colleague, and neither shows him her connection", async () => {
    const [fromSheet, fromChat] = [await sheet(colleague.headers), await chat(colleague.headers)];

    expect(fromSheet.availability).toMatchObject({ via: "organization", state: "active" });
    expect(fromSheet.active).toBe(true);
    expect(fromSheet.connections).toEqual([]);
    // He holds no connection, so the chat lists none for him at all.
    expect(fromChat?.connections ?? []).toEqual([]);
  });

  it("both list her connection for the colleague, as not his, once she shares it into his space", async () => {
    const share = await app.request(`/api/me/connections/${connectionId}/shares/${teamSpaceId}`, {
      method: "PUT",
      headers: authHeaders(olivia),
    });
    expect(share.status, await share.clone().text()).toBe(204);

    const [fromSheet, fromChat] = [await sheet(colleague.headers), await chat(colleague.headers)];

    expect(fromSheet.connections.map((c) => c.id)).toEqual([connectionId]);
    expect(fromChat?.active).toBe(fromSheet.active);
    expect(fromChat?.via).toBe(fromSheet.availability.via);
    expect(fromChat?.connections.map((c) => c.id)).toEqual(fromSheet.connections.map((c) => c.id));
    expect(fromChat?.connections[0]?.owned_by_actor).toBe(false);
    expect(fromSheet.connections[0]!.owner_id).not.toBe(colleague.id);
    expect(fromSheet.connections[0]!.owner_id).toBe(olivia.user.id);
  });

  it("both say inactive when the space switched it off, and the chat still lists the connection", async () => {
    await seedSpacePackage(olivia.defaultSpaceId, INTEGRATION, {
      enabled: false,
      placedByOffer: true,
    });
    const headers = authHeaders(olivia);
    const [fromSheet, fromChat] = [await sheet(headers), await chat(headers)];

    expect(fromSheet.availability).toMatchObject({ via: "organization", state: "inactive" });
    expect(fromSheet.active).toBe(false);
    expect(fromChat?.active).toBe(false);
    expect(fromChat?.via).toBe(fromSheet.availability.via);
    expect(fromChat?.connections.map((c) => c.id)).toEqual([connectionId]);
  });

  it("both drop the connection once the published version declares no auth, and keep it before", async () => {
    await seedPublishedVersion(INTEGRATION, "1.0.0");
    const headers = authHeaders(olivia);
    const [before, beforeChat] = [await sheet(headers), await chat(headers)];
    expect(before.connections.map((c) => c.id)).toEqual([connectionId]);
    expect(beforeChat?.connections.map((c) => c.id)).toEqual([connectionId]);

    // v2 declares no auth at all.
    const { auths: _removed, ...withoutAuths } = localIntegrationManifest({
      name: INTEGRATION,
      version: "2.0.0",
      displayName: "CRM",
      auths: {},
    }) as unknown as Record<string, unknown>;
    await seedPublishedVersion(INTEGRATION, "2.0.0", { manifest: withoutAuths });
    const [after, afterChat] = [await sheet(headers), await chat(headers)];
    expect(after.connections).toEqual([]);
    // No connection left: the chat lists no entry for the integration at all.
    expect(afterChat).toBeUndefined();
  });
});
