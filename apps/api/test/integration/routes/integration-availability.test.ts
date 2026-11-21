// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/integrations/{packageId}` carries `availability`: the library's
 * answer for (this package, the current space), projected — never recomputed.
 *
 * Every case asserts the same two things beside its own expectation: the
 * object equals the matching cell of `GET /api/spaces/{id}/library` for the
 * same caller (the "no second calculation" proof), and the detail's `active`
 * agrees with `availability.state`.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberHolding,
  type TestContext,
} from "../../helpers/auth.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { loopbackHeaders } from "../../helpers/loopback.ts";
import { MCP_ACCEPT, type JsonRpcEnvelope } from "../../helpers/mcp.ts";
import { registerTestPlatformApp } from "../../helpers/platform-app.ts";
import { orgPermissions, presetPermissions } from "../../../src/lib/permissions.ts";
import { getMcpOrgResourceUri } from "../../../src/lib/audiences.ts";
import { overrideJwks } from "../../../src/modules/oidc/services/enduser-token.ts";
import { resetOidcGuardsLimiters } from "../../../src/modules/oidc/auth/guards.ts";
import { authorizationCodeFlow } from "../../../src/modules/oidc/test/helpers/authorization-code-flow.ts";
import mcpModule from "../../../src/modules/mcp/index.ts";
import {
  seedApiKey,
  seedOrgOffer,
  seedPackage,
  seedSpace,
  seedSpacePackage,
} from "../../helpers/seed.ts";
import {
  httpHeaderDelivery,
  localIntegrationManifest,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();
await registerTestPlatformApp();

const REDIRECT_URI = "http://localhost:9918/callback";

const HOMED = "@probe/homed-integration";
const SHARED = "@probe/shared-integration";
const OFFERED = "@probe/offered-integration";

let ctx: TestContext;
let otherTeam: string;

function manifestFor(id: string) {
  return localIntegrationManifest({
    name: id,
    displayName: id,
    auths: {
      api: {
        type: "api_key",
        authorizedUris: ["https://example.test/**"],
        delivery: httpHeaderDelivery({
          name: "Authorization",
          prefix: "Bearer ",
          field: "api_key",
        }),
      },
    },
  }) as unknown as Record<string, unknown>;
}

interface Availability {
  via: string;
  state: string;
  shared_by: { user_id: string; name: string } | null;
  offered_to_org: boolean;
  org_offerable: boolean;
}

/** The detail's `availability` and `active`, plus the library's cell for the same caller. */
async function read(as: TestContext, id: string) {
  const res = await app.request(`/api/integrations/${id}`, { headers: authHeaders(as) });
  expect(res.status, await res.clone().text()).toBe(200);
  const detail = (await res.json()) as { active: boolean; availability: Availability };

  const lib = await app.request(`/api/spaces/${as.defaultSpaceId}/library`, {
    headers: authHeaders(as),
  });
  expect(lib.status, await lib.clone().text()).toBe(200);
  const library = (await lib.json()) as {
    packages: {
      integration: {
        id: string;
        offered_to_org: boolean;
        org_offerable: boolean;
        placements: {
          space_id: string;
          via: string;
          state: string;
          shared_by: Availability["shared_by"];
        }[];
      }[];
    };
  };
  const entry = library.packages.integration.find((p) => p.id === id)!;
  const placement = entry.placements.find((p) => p.space_id === as.defaultSpaceId)!;
  const fromLibrary = {
    via: placement.via,
    state: placement.state,
    shared_by: placement.shared_by,
    offered_to_org: entry.offered_to_org,
    org_offerable: entry.org_offerable,
  };

  expect(detail.availability).toEqual(fromLibrary);
  expect(detail.active).toBe(detail.availability.state === "active");
  return detail.availability;
}

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext();
  otherTeam = (await seedSpace({ orgId: ctx.orgId, name: "Other team" })).id;
  for (const [id, home] of [
    [HOMED, ctx.defaultSpaceId],
    [SHARED, otherTeam],
    [OFFERED, otherTeam],
  ] as const) {
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "integration",
      homeSpaceId: home,
      draftManifest: manifestFor(id),
    });
  }
});

describe("GET /api/integrations/{packageId} — availability", () => {
  it("reads `home` for an integration homed in the space", async () => {
    const a = await read(ctx, HOMED);
    expect(a).toMatchObject({ via: "home", shared_by: null, offered_to_org: false });
  });

  it("reads `shared`, with who shared it, for an integration homed elsewhere", async () => {
    await seedSpacePackage(ctx.defaultSpaceId, SHARED, {
      enabled: true,
      sharedBy: ctx.user.id,
    });
    const a = await read(ctx, SHARED);
    expect(a).toMatchObject({ via: "shared", state: "active" });
    expect(a.shared_by?.user_id).toBe(ctx.user.id);
  });

  it("reads `organization` and `active` for an offer with no row of the space's own", async () => {
    await seedOrgOffer(ctx.orgId, OFFERED);
    const a = await read(ctx, OFFERED);
    expect(a).toMatchObject({ via: "organization", state: "active", offered_to_org: true });
  });

  it("reads `inactive` once the space has switched the integration off", async () => {
    await seedSpacePackage(ctx.defaultSpaceId, HOMED, { enabled: false });
    const a = await read(ctx, HOMED);
    expect(a).toMatchObject({ via: "home", state: "inactive" });
  });

  it("reads `shared` for a row an offer no longer explains, as the detail route's own placement rule does", async () => {
    // `placed_by_offer` row left behind after the offer was withdrawn.
    await seedSpacePackage(ctx.defaultSpaceId, OFFERED, { enabled: true, placedByOffer: true });
    const a = await read(ctx, OFFERED);
    expect(a).toMatchObject({ via: "shared", state: "active", offered_to_org: false });
  });

  it("404s on an integration homed in another space and placed nowhere else", async () => {
    const res = await app.request(`/api/integrations/${SHARED}`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(404);
  });

  it("gives an owner the offer verdict", async () => {
    // An offer already stands, so withdrawing it needs no published version.
    await seedOrgOffer(ctx.orgId, OFFERED);
    const a = await read(ctx, OFFERED);
    expect(a.org_offerable).toBe(true);
  });

  it("refuses the offer switch to a caller holding only the read grants", async () => {
    const reader = await memberHolding(ctx, ["integrations:read", "spaces:read"]);
    const a = await read(reader, HOMED);
    expect(a.org_offerable).toBe(false);
  });

  it("answers the same on PATCH …/settings, which returns the same resource", async () => {
    await seedOrgOffer(ctx.orgId, OFFERED);
    const get = await app.request(`/api/integrations/${OFFERED}`, { headers: authHeaders(ctx) });
    const patch = await app.request(`/api/integrations/${OFFERED}/settings`, {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ block_user_connections: false }),
    });
    expect(patch.status, await patch.clone().text()).toBe(200);
    const fromGet = (await get.json()) as { availability: Availability };
    const fromPatch = (await patch.json()) as { availability: Availability };
    expect(fromPatch.availability).toEqual(fromGet.availability);
  });
});

describe("GET /api/integrations/{packageId} — the same availability through every credential", () => {
  beforeEach(async () => {
    await flushRedis();
    resetOidcGuardsLimiters();
    overrideJwks(null);
    await mcpModule.events!.onOrgCreate!(ctx.orgId, ctx.user.email);
    await seedOrgOffer(ctx.orgId, OFFERED);
  });

  /** The placement half of `availability`: what a credential's ceiling cannot change. */
  const placementOf = ({ via, state, shared_by, offered_to_org }: Availability) => ({
    via,
    state,
    shared_by,
    offered_to_org,
  });

  it("answers the chat's loopback bearer what it answers the session", async () => {
    const headers = {
      ...loopbackHeaders(ctx, ctx.orgId, {
        orgRole: "owner",
        permissions: [...orgPermissions("owner"), ...presetPermissions("admin"), "mcp:read"],
      }),
      "X-Space-Id": ctx.defaultSpaceId,
    };
    const res = await app.request(`/api/integrations/${OFFERED}`, { headers });
    expect(res.status, await res.clone().text()).toBe(200);
    const { availability } = (await res.json()) as { availability: Availability };
    expect(availability).toEqual(await read(ctx, OFFERED));
  });

  it("answers a space-pinned API key what it answers the session", async () => {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["integrations:read"],
    });
    const res = await app.request(`/api/integrations/${OFFERED}`, {
      headers: { Authorization: `Bearer ${key.rawKey}` },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { availability } = (await res.json()) as { availability: Availability };
    // The key's scopes may narrow the offer switch; the placement is the library's.
    expect(placementOf(availability)).toEqual(placementOf(await read(ctx, OFFERED)));
  });

  it("answers a real minted MCP instance token what it answers the session", async () => {
    const registered = await app.request("/api/auth/oauth2/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "MCP client (availability)",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect([200, 201]).toContain(registered.status);
    const { client_id: clientId } = (await registered.json()) as { client_id: string };
    const { token } = await authorizationCodeFlow(app, {
      cookie: ctx.cookie,
      clientId,
      redirectUri: REDIRECT_URI,
      scope: "openid mcp:read mcp:invoke",
      resource: getMcpOrgResourceUri(ctx.orgId),
    });

    const res = await app.request(`/api/mcp/o/${ctx.orgId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${String(token.access_token)}`,
        "content-type": "application/json",
        Accept: MCP_ACCEPT,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "invoke_operation",
          arguments: {
            operation_id: "getIntegration",
            path_params: { packageId: OFFERED },
            space_id: ctx.defaultSpaceId,
          },
        },
      }),
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const envelope = JSON.parse(text) as JsonRpcEnvelope;
    const content = envelope.result?.content as Array<{ text: string }>;
    expect(envelope.result?.isError, content[0]!.text).toBeFalsy();
    const { status, body } = JSON.parse(content[0]!.text) as {
      status: number;
      body: { availability: Availability };
    };
    expect(status).toBe(200);
    // The token's scope ceiling may narrow the offer switch; the placement is the library's.
    expect(placementOf(body.availability)).toEqual(placementOf(await read(ctx, OFFERED)));
  });
});
