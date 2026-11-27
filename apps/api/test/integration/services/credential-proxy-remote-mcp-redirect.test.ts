// SPDX-License-Identifier: Apache-2.0

/**
 * A redirect hop onto a remote integration's MCP endpoint is refused like a direct call to it:
 * raw HTTP never reaches the server without the space's tool policy.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { proxyCall, ProxyCallError } from "../../../src/services/credential-proxy/core.ts";
import { remoteIntegrationManifest } from "../../helpers/integration-manifests.ts";
import {
  bearerApiKeyAuth,
  seedProxyConnection,
  seedProxyIntegration,
} from "../../helpers/credential-proxy-fixtures.ts";
import { remoteMcpEndpointNotProxied } from "../../../src/services/integration-tool-catalog.ts";

const ID = "@mcpredir/files";
const ORIGIN = "https://1.1.1.1";

describe("proxyCall — redirect onto the remote MCP endpoint", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "mcpredir" });
    await seedProxyIntegration(
      ctx,
      remoteIntegrationManifest({
        name: ID,
        url: `${ORIGIN}/mcp`,
        auths: { api_key: bearerApiKeyAuth([`${ORIGIN}/**`]) },
      }),
    );
    await seedProxyConnection(ctx, ID, "api_key", { token: "t" });
  });

  it("refuses the hop with the endpoint refusal and never requests the endpoint", async () => {
    const hits: string[] = [];
    const fetchImpl = ((url: string | URL) => {
      hits.push(url.toString());
      return Promise.resolve(
        url.toString() === `${ORIGIN}/other`
          ? new Response(null, { status: 302, headers: { location: `${ORIGIN}/mcp` } })
          : new Response("{}"),
      );
    }) as unknown as typeof fetch;

    const err = await proxyCall({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      reach: "own",
      integrationId: ID,
      method: "GET",
      target: `${ORIGIN}/other`,
      headers: {},
      body: null,
      substituteBody: false,
      fetch: fetchImpl,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ProxyCallError);
    expect((err as Error).message).toContain(remoteMcpEndpointNotProxied(ID).message);
    expect(hits).toEqual([`${ORIGIN}/other`]);
  });
});
