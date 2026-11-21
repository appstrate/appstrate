// SPDX-License-Identifier: Apache-2.0

/**
 * The remedy a configuration refusal advertises — `POST /api/spaces/{target}/packages` — runs for
 * the same caller through every door: a session (REST and MCP), a minted MCP instance token and
 * the chat's loopback bearer bound to a set of spaces, whichever of its spaces the call names.
 * Placing a package outside its home is judged in the home over the credential's own reach, so a
 * credential that does not reach the home (a conversation limited to the target, the space-pinned
 * endpoint) still cannot place it.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { ACTIVE_SPACES_META_KEY } from "@appstrate/core/mcp-spaces";
import { db } from "@appstrate/db/client";
import { spacePackages } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../test/helpers/db.ts";
import { flushRedis } from "../../../../../test/helpers/redis.ts";
import {
  createTestContext,
  memberHolding,
  type TestContext,
} from "../../../../../test/helpers/auth.ts";
import {
  seedApiKey,
  seedEndUser,
  seedPackage,
  seedPackageShare,
  seedPublishedVersion,
  seedSpace,
  seedSpaceGrant,
  seedSpaceMember,
  seedSpacePackage,
} from "../../../../../test/helpers/seed.ts";
import { MCP_ACCEPT, type JsonRpcEnvelope } from "../../../../../test/helpers/mcp.ts";
import { registerTestPlatformApp } from "../../../../../test/helpers/platform-app.ts";
import { loopbackHeaders } from "../../../../../test/helpers/loopback.ts";
import {
  httpHeaderDelivery,
  localIntegrationManifest,
} from "../../../../../test/helpers/integration-manifests.ts";
import { getMcpOrgResourceUri } from "../../../../lib/audiences.ts";
import { dispatchPinEnv } from "../../../../lib/internal-dispatch.ts";
import { overrideJwks } from "../../../oidc/services/enduser-token.ts";
import { resetOidcGuardsLimiters } from "../../../oidc/auth/guards.ts";
import { authorizationCodeFlow } from "../../../oidc/test/helpers/authorization-code-flow.ts";
import mcpModule from "../../index.ts";

const app = getTestApp();
await registerTestPlatformApp();

const REDIRECT_URI = "http://localhost:9919/callback";
const INTEGRATION = "@remedy/svc";
const AGENT = "@remedy/needy";
/** The chat turn's ceiling: what an owner's turn carries for these acts. */
const TURN_PERMISSIONS = [
  "mcp:read",
  "mcp:invoke",
  "spaces:read",
  "agents:read",
  "agents:run",
  "agents:configure",
  "integrations:read",
  "integrations:install",
  "integrations:share",
];

describe("the activation remedy, through every door", () => {
  let ctx: TestContext;
  let vitrine: string;
  let orgEndpoint: string;

  async function mintOrgToken(): Promise<string> {
    const registered = await app.request("/api/auth/oauth2/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "MCP client (activation remedy)",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    const { client_id: clientId } = (await registered.json()) as { client_id: string };
    const { token } = await authorizationCodeFlow(app, {
      cookie: ctx.cookie,
      clientId,
      redirectUri: REDIRECT_URI,
      scope: "openid mcp:read mcp:invoke",
      resource: getMcpOrgResourceUri(ctx.orgId),
    });
    return `Bearer ${String(token.access_token)}`;
  }

  /** The chat's bearer over `spaceIds`, its turn carrying `permissions`. */
  function chat(spaceIds: string[], permissions = TURN_PERMISSIONS): Record<string, string> {
    return loopbackHeaders(ctx, ctx.orgId, { orgRole: "owner", permissions, spaceIds });
  }

  /** An MCP tool's relayed HTTP status and body. */
  async function invoke(
    endpoint: string,
    headers: Record<string, string>,
    args: Record<string, unknown>,
    tool = "invoke_operation",
  ): Promise<{ status: number; body: Record<string, unknown>; readSpaces?: unknown }> {
    const res = await app.request(endpoint, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
    });
    const envelope = (await res.json()) as JsonRpcEnvelope;
    const content = (envelope.result?.content as Array<{ text: string }>) ?? [];
    const answer = JSON.parse(content[0]!.text) as {
      status: number;
      body: Record<string, unknown>;
    };
    const meta = envelope.result?._meta as Record<string, unknown> | undefined;
    return { ...answer, readSpaces: meta?.[ACTIVE_SPACES_META_KEY] };
  }

  /** `activatePackage` of `packageId` into Vitrine, the call naming `spaceId`. */
  function activateInVitrine(
    endpoint: string,
    headers: Record<string, string>,
    packageId: string,
    spaceId?: string,
  ) {
    return invoke(endpoint, headers, {
      operation_id: "activatePackage",
      ...(spaceId ? { space_id: spaceId } : {}),
      path_params: { id: vitrine },
      body: { packageId },
    });
  }

  async function rowIn(spaceId: string, packageId: string) {
    const [row] = await db
      .select({ enabled: spacePackages.enabled })
      .from(spacePackages)
      .where(and(eq(spacePackages.spaceId, spaceId), eq(spacePackages.packageId, packageId)));
    return row ?? null;
  }

  async function clearVitrine(packageId: string): Promise<void> {
    await db
      .delete(spacePackages)
      .where(and(eq(spacePackages.spaceId, vitrine), eq(spacePackages.packageId, packageId)));
  }

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    overrideJwks(null);
    ctx = await createTestContext({ orgSlug: "remedy" });
    await mcpModule.events!.onOrgCreate!(ctx.orgId, ctx.user.email);
    vitrine = (await seedSpace({ orgId: ctx.orgId, name: "Vitrine" })).id;
    orgEndpoint = `/api/mcp/o/${ctx.orgId}`;
    // Homed in the default space, placed nowhere else: Vitrine holds no row of it.
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      homeSpaceId: ctx.defaultSpaceId,
      type: "integration",
      source: "local",
      draftManifest: localIntegrationManifest({
        name: INTEGRATION,
        auths: {
          primary: {
            type: "api_key",
            authorizedUris: ["https://api.example.com/**"],
            credentialFields: ["api_key"],
            delivery: httpHeaderDelivery({ name: "Authorization", field: "api_key" }),
          },
        },
        tools_policy: { search: {} },
      }) as unknown as Record<string, unknown>,
    });
    await seedPublishedVersion(INTEGRATION, "1.0.0");
    await seedPackage({
      id: AGENT,
      orgId: ctx.orgId,
      homeSpaceId: ctx.defaultSpaceId,
      draftManifest: {
        name: AGENT,
        version: "1.0.0",
        type: "agent",
        schema_version: "0.2",
        display_name: "Needy",
        dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
        integrations_configuration: { [INTEGRATION]: { tools: ["search"], required: true } },
      },
    });
    await seedPublishedVersion(AGENT, "1.0.0");
  });

  it("places and activates the integration in the target, whichever space the call names", async () => {
    const doors: [string, () => Promise<number>][] = [
      [
        "session REST",
        async () =>
          (
            await app.request(`/api/spaces/${vitrine}/packages`, {
              method: "POST",
              headers: {
                Cookie: ctx.cookie,
                "X-Org-Id": ctx.orgId,
                "X-Space-Id": vitrine,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ packageId: INTEGRATION }),
            })
          ).status,
      ],
      [
        "session MCP",
        async () =>
          (
            await activateInVitrine(
              orgEndpoint,
              { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
              INTEGRATION,
              vitrine,
            )
          ).status,
      ],
      [
        "MCP instance token",
        async () =>
          (
            await activateInVitrine(
              orgEndpoint,
              { Authorization: await mintOrgToken() },
              INTEGRATION,
              vitrine,
            )
          ).status,
      ],
      // The call the 409 advertises, from the space it refused in.
      [
        "chat, naming the target",
        async () =>
          (
            await activateInVitrine(
              orgEndpoint,
              chat([ctx.defaultSpaceId, vitrine]),
              INTEGRATION,
              vitrine,
            )
          ).status,
      ],
      [
        "chat, naming the home",
        async () =>
          (
            await activateInVitrine(
              orgEndpoint,
              chat([ctx.defaultSpaceId, vitrine]),
              INTEGRATION,
              ctx.defaultSpaceId,
            )
          ).status,
      ],
    ];
    for (const [door, call] of doors) {
      await clearVitrine(INTEGRATION);
      expect({ door, status: await call() }).toEqual({ door, status: 201 });
      expect(await rowIn(vitrine, INTEGRATION)).toEqual({ enabled: true });
    }
  });

  it("shares from the home into the target through the chat, whichever space the call names", async () => {
    for (const spaceId of [ctx.defaultSpaceId, vitrine]) {
      await clearVitrine(INTEGRATION);
      const res = await invoke(orgEndpoint, chat([ctx.defaultSpaceId, vitrine]), {
        operation_id: "sharePackage",
        space_id: spaceId,
        path_params: { scope: "@remedy", name: "svc" },
        body: { target: { kind: "space", spaceId: vitrine } },
      });
      expect({ spaceId, status: res.status }).toEqual({ spaceId, status: 201 });
      expect(await rowIn(vitrine, INTEGRATION)).toEqual({ enabled: true });
    }
  });

  it("places nothing for a credential that does not reach the home", async () => {
    // A conversation limited to the target, and a session on the endpoint pinned to it.
    const limited = await activateInVitrine(orgEndpoint, chat([vitrine]), INTEGRATION, vitrine);
    expect(limited.status).toBe(404);
    const pinned = await activateInVitrine(
      `${orgEndpoint}/s/${vitrine}`,
      { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      INTEGRATION,
    );
    expect(pinned.status).toBe(404);
    expect(await rowIn(vitrine, INTEGRATION)).toBeNull();
  });

  it("places nothing for a chat whose turn lacks the share grant, though its set holds the home", async () => {
    const withoutShare = TURN_PERMISSIONS.filter((p) => p !== "integrations:share");
    for (const spaceId of [ctx.defaultSpaceId, vitrine]) {
      const res = await activateInVitrine(
        orgEndpoint,
        chat([ctx.defaultSpaceId, vitrine], withoutShare),
        INTEGRATION,
        spaceId,
      );
      // It reaches the package, so the refusal is the missing grant, never a 404.
      expect({ spaceId, status: res.status }).toEqual({ spaceId, status: 403 });
    }
    expect(await rowIn(vitrine, INTEGRATION)).toBeNull();
  });

  it("keeps a per-call dispatch pin for a credential bound to no set", async () => {
    // A session confined to the target by a per-call pin does not reach the home.
    const res = await app.request(
      `/api/spaces/${vitrine}/packages`,
      {
        method: "POST",
        headers: {
          Cookie: ctx.cookie,
          "X-Org-Id": ctx.orgId,
          "X-Space-Id": vitrine,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ packageId: INTEGRATION }),
      },
      dispatchPinEnv({ spaceId: vitrine }),
    );
    expect(res.status).toBe(404);
    expect(await rowIn(vitrine, INTEGRATION)).toBeNull();
  });

  it("places nothing from a set that excludes the home, nor for a key or an end-user of the target", async () => {
    const other = (await seedSpace({ orgId: ctx.orgId, name: "Autre" })).id;
    const unlimited = await activateInVitrine(
      orgEndpoint,
      chat([vitrine, other]),
      INTEGRATION,
      vitrine,
    );
    expect(unlimited.status).toBe(404);

    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: vitrine,
      createdBy: ctx.user.id,
      scopes: ["integrations:read", "integrations:install", "spaces:read"],
    });
    const endUser = await seedEndUser({ orgId: ctx.orgId, spaceId: vitrine });
    const pinned = { Authorization: `Bearer ${key.rawKey}`, "Content-Type": "application/json" };
    for (const headers of [pinned, { ...pinned, "Appstrate-User": endUser.id }]) {
      const res = await app.request(`/api/spaces/${vitrine}/packages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ packageId: INTEGRATION }),
      });
      // Neither reaches the home for placement: the package is not found, never a 403.
      expect(res.status).toBe(404);
    }
    expect(await rowIn(vitrine, INTEGRATION)).toBeNull();
  });

  it("refuses another organization's package through the chat", async () => {
    const stranger = await createTestContext({ orgSlug: "stranger" });
    const FOREIGN = "@stranger/svc";
    await seedPackage({
      id: FOREIGN,
      orgId: stranger.orgId,
      homeSpaceId: stranger.defaultSpaceId,
      type: "integration",
      source: "local",
    });
    const res = await activateInVitrine(
      orgEndpoint,
      chat([ctx.defaultSpaceId, vitrine]),
      FOREIGN,
      vitrine,
    );
    expect(res.status).toBe(404);
    expect(await rowIn(vitrine, FOREIGN)).toBeNull();
  });

  it("withdraws a share on the home's authority through the chat only when its set holds the home", async () => {
    await seedPackageShare(vitrine, INTEGRATION, ctx.user.id);
    const revoke = (headers: Record<string, string>) =>
      invoke(orgEndpoint, headers, {
        operation_id: "revokePackageShare",
        space_id: vitrine,
        path_params: { scope: "@remedy", name: "svc", target: vitrine },
      });
    // The turn carries no deactivation grant: only the home's `share` can withdraw it.
    expect((await revoke(chat([vitrine]))).status).toBe(403);
    expect(await rowIn(vitrine, INTEGRATION)).toEqual({ enabled: false });
    expect((await revoke(chat([ctx.defaultSpaceId, vitrine]))).status).toBe(204);
    expect(await rowIn(vitrine, INTEGRATION)).toBeNull();
  });

  it("lists a package's shares only on the home's authority in the space the call entered", async () => {
    await seedPackageShare(vitrine, INTEGRATION, ctx.user.id);
    const list = (spaceId: string) =>
      invoke(orgEndpoint, chat([ctx.defaultSpaceId, vitrine]), {
        operation_id: "listPackageShares",
        space_id: spaceId,
        path_params: { scope: "@remedy", name: "svc" },
      });
    expect((await list(ctx.defaultSpaceId)).status).toBe(200);
    // Entered in the target, the read reaches the target alone: no home authority there.
    expect((await list(vitrine)).status).toBe(403);
  });

  it("switches on an agent placed in the target but off there, through every door", async () => {
    const doors: [string, string, Record<string, string>][] = [
      ["chat", orgEndpoint, chat([ctx.defaultSpaceId, vitrine])],
      ["chat limited to the target", orgEndpoint, chat([vitrine])],
      ["MCP instance token", orgEndpoint, { Authorization: await mintOrgToken() }],
      [
        "session, pinned endpoint",
        `${orgEndpoint}/s/${vitrine}`,
        { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      ],
    ];
    for (const [door, endpoint, headers] of doors) {
      await seedSpacePackage(vitrine, AGENT, { enabled: false });
      const pinned = endpoint !== orgEndpoint;
      const res = await activateInVitrine(endpoint, headers, AGENT, pinned ? undefined : vitrine);
      expect({ door, status: res.status }).toEqual({ door, status: 201 });
      expect(await rowIn(vitrine, AGENT)).toEqual({ enabled: true });
    }
  });

  it("offers only spaces where the same MCP tool can repeat the call", async () => {
    // REST can run in both destinations. Only one admits invoke_operation, and
    // neither admits run_and_wait: following the run requires a read grant.
    const caller = await memberHolding(ctx, ["agents:run"]);
    const invokeOnly = await seedSpace({ orgId: ctx.orgId, name: "Invoke only" });
    await seedSpaceMember({ spaceId: vitrine, userId: caller.user.id, presetRole: "operator" });
    await seedSpaceGrant({
      orgId: ctx.orgId,
      spaceId: invokeOnly.id,
      userId: caller.user.id,
      permissions: ["agents:run", "mcp:read", "mcp:invoke"],
    });
    await seedSpacePackage(vitrine, AGENT, { enabled: false });
    for (const spaceId of [ctx.defaultSpaceId, invokeOnly.id]) {
      for (const id of [AGENT, INTEGRATION]) await seedSpacePackage(spaceId, id);
    }
    const session = { Cookie: caller.cookie, "X-Org-Id": ctx.orgId };
    const rest = await app.request("/api/agents/@remedy/needy/run", {
      method: "POST",
      headers: { ...session, "X-Space-Id": vitrine },
    });
    expect(rest.status).toBe(404);
    const restBody = (await rest.json()) as { code: string; active_in_spaces: { id: string }[] };
    expect(restBody.code).toBe("agent_not_active_in_space");
    expect(restBody.active_in_spaces.map(({ id }) => id).sort()).toEqual(
      [ctx.defaultSpaceId, invokeOnly.id].sort(),
    );

    const invoked = await invoke(orgEndpoint, session, {
      operation_id: "runAgent",
      space_id: vitrine,
      path_params: { scope: "@remedy", name: "needy" },
    });
    expect(invoked.status).toBe(404);
    expect(invoked.body.active_in_spaces).toEqual([{ id: invokeOnly.id, name: invokeOnly.name }]);
    expect(invoked.readSpaces).toEqual([invokeOnly.id]);

    const waited = await invoke(
      orgEndpoint,
      session,
      {
        kind: "agent",
        scope: "@remedy",
        name: "needy",
        space_id: vitrine,
      },
      "run_and_wait",
    );
    expect(waited.status).toBe(404);
    expect(waited.body.active_in_spaces).toEqual([]);
    expect(waited.body.detail).not.toContain("use it in one of active_in_spaces");
  });

  it("keeps a space-bound draft in its author's space on an integration 409", async () => {
    for (const id of [ctx.defaultSpaceId, vitrine]) await seedSpacePackage(id, AGENT);
    await seedSpacePackage(vitrine, INTEGRATION);
    const headers = chat(
      [ctx.defaultSpaceId, vitrine],
      [...TURN_PERMISSIONS, "agents:write", "integrations:write"],
    );
    const launch = (version: string, overrides = {}) =>
      invoke(orgEndpoint, headers, {
        operation_id: "runAgent",
        space_id: ctx.defaultSpaceId,
        path_params: { scope: "@remedy", name: "needy" },
        query: { version },
        body: { dependency_overrides: overrides },
      });
    for (const [version, overrides, expected] of [
      ["published", {}, [{ id: vitrine, name: "Vitrine" }]],
      ["draft", {}, []],
      ["published", { [INTEGRATION]: "draft" }, []],
    ] as const) {
      const result = await launch(version, overrides);
      expect(result.status).toBe(409);
      expect(result.body.active_in_spaces).toEqual(expected);
    }
  });

  it("offers no other space on the space-pinned endpoint, one on the organization endpoint", async () => {
    // Off in Vitrine; on with its integration in the default space (its home).
    await seedSpacePackage(vitrine, AGENT, { enabled: false });
    for (const id of [AGENT, INTEGRATION]) await seedSpacePackage(ctx.defaultSpaceId, id);
    const session = { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId };
    const run = (endpoint: string, spaceId?: string) =>
      invoke(endpoint, session, {
        operation_id: "runAgent",
        ...(spaceId ? { space_id: spaceId } : {}),
        path_params: { scope: "@remedy", name: "needy" },
        body: {},
      });

    const orgWide = await run(orgEndpoint, vitrine);
    expect(orgWide.status).toBe(404);
    expect(orgWide.body.code).toBe("agent_not_active_in_space");
    expect(orgWide.body.active_in_spaces).toEqual([
      { id: ctx.defaultSpaceId, name: expect.any(String) },
    ]);

    const pinned = await run(`${orgEndpoint}/s/${vitrine}`);
    expect(pinned.status).toBe(404);
    expect(pinned.body.code).toBe("agent_not_active_in_space");
    expect(pinned.body.active_in_spaces).toEqual([]);
  });
});
