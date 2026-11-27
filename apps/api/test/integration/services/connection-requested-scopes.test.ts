// SPDX-License-Identifier: Apache-2.0

/**
 * A connection's step-up demand: the scopes a server asked for that it does not hold. One writer
 * (`recordRequestedScopes`, behind its reach, OAuth2 only), cleared by the credential write that grants them.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { notifications, packages } from "@appstrate/db/schema";
import type { Actor } from "@appstrate/connect";
import { MAX_REQUIRED_SCOPES } from "@appstrate/core/www-authenticate";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, memberContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { requestedScopesOf } from "../../helpers/connection-calls.ts";
import { settle, until } from "../../helpers/credential-death-spy.ts";
import {
  recordRequestedScopes,
  saveIntegrationConnection,
} from "../../../src/services/integration-connections.ts";
import type { SpaceScope } from "../../../src/lib/scope.ts";

const INTEGRATION = "@orga/mail";

/** A valid integration manifest whose `oauth` auth carries `scopeCatalog` (none: no catalog). */
const manifestWith = (scopeCatalog?: string[]) => ({
  type: "integration",
  schema_version: "0.1",
  name: INTEGRATION,
  version: "0.1.0",
  display_name: "Mail",
  description: "Mail integration",
  source: {
    kind: "local",
    server: {
      type: "node",
      entry_point: "server/index.js",
      mcp_config: { command: "node", args: ["server/index.js"] },
    },
  },
  auths: {
    oauth: {
      type: "oauth2",
      authorization_endpoint: "https://mail.example.com/authorize",
      token_endpoint: "https://mail.example.com/token",
      ...(scopeCatalog
        ? { scope_catalog: scopeCatalog.map((value) => ({ value, label: value })) }
        : {}),
      authorized_uris: ["https://mail.example.com/**"],
      delivery: {
        http: {
          in: "header",
          name: "Authorization",
          prefix: "Bearer ",
          value: "{$credential.access_token}",
        },
      },
    },
    key: {
      type: "api_key",
      credentials: {
        schema: {
          type: "object",
          properties: { api_key: { type: "string" } },
          required: ["api_key"],
        },
      },
      authorized_uris: ["https://mail.example.com/**"],
      delivery: {
        http: { in: "header", name: "X-Api-Key", value: "{$credential.api_key}" },
      },
    },
  },
});

describe("connection requested scopes", () => {
  let ctx: TestContext;
  let scope: SpaceScope;
  let actor: Actor;
  let connectionId: string;
  let reach: { spaceId: string; actor: Actor };

  const requested = (id = connectionId) => requestedScopesOf(id);

  const save = (scopesGranted: string[], id?: string) =>
    saveIntegrationConnection(scope, {
      packageId: INTEGRATION,
      authKey: "oauth",
      accountId: "alice@example.com",
      credentials: { access_token: "tok" },
      identityClaims: { email: "alice@example.com" },
      scopesGranted,
      clientRef: "test-client",
      actor,
      connectionId: id,
    });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "reqscopes" });
    scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    actor = { type: "user", id: ctx.user.id };
    reach = { spaceId: ctx.defaultSpaceId, actor };
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifestWith(),
    });
    connectionId = (await save(["read"])).id;
  });

  it("keeps the valid scopes the connection does not hold, once each", async () => {
    await recordRequestedScopes(connectionId, INTEGRATION, reach, ["read", "write", "bad scope"]);
    expect(await requested()).toEqual(["write"]);
    await recordRequestedScopes(connectionId, INTEGRATION, reach, ["write", "admin"]);
    expect(await requested()).toEqual(["write", "admin"]);
  });

  it("is bounded", async () => {
    for (let i = 0; i < 4; i++) {
      await recordRequestedScopes(
        connectionId,
        INTEGRATION,
        reach,
        Array.from({ length: MAX_REQUIRED_SCOPES }, (_, j) => `s${i}_${j}`),
      );
    }
    // The latest demand survives the cap: the one a reconnect now would answer.
    expect(await requested()).toEqual(
      Array.from({ length: MAX_REQUIRED_SCOPES }, (_, j) => `s3_${j}`),
    );
  });

  it("keeps only the scopes the auth's scope_catalog lets a reconnect request", async () => {
    await db
      .update(packages)
      .set({ draftManifest: manifestWith(["read", "write"]) })
      .where(eq(packages.id, INTEGRATION));
    await recordRequestedScopes(connectionId, INTEGRATION, reach, ["write", "admin"]);
    expect(await requested()).toEqual(["write"]);
    expect(await recordRequestedScopes(connectionId, INTEGRATION, reach, ["admin"])).toBeNull();
    expect(await requested()).toEqual(["write"]);
  });

  it("records nothing for a caller that does not reach the connection", async () => {
    const other = await memberContext(ctx, "member");
    const unreached = await recordRequestedScopes(
      connectionId,
      INTEGRATION,
      { spaceId: ctx.defaultSpaceId, actor: { type: "user", id: other.user.id } },
      ["write"],
    );
    expect(unreached).toBeNull();
    expect(await requested()).toEqual([]);
  });

  it("records nothing on a connection no consent grants scopes to (no minting client)", async () => {
    const keyed = await saveIntegrationConnection(scope, {
      packageId: INTEGRATION,
      authKey: "key",
      accountId: "key-account",
      credentials: { api_key: "k" },
      actor,
    });
    expect(await recordRequestedScopes(keyed.id, INTEGRATION, reach, ["write"])).toBeNull();
    expect(await requested(keyed.id)).toEqual([]);
  });

  it("is cleared by the reconnect that grants the scopes, and only by it", async () => {
    await recordRequestedScopes(connectionId, INTEGRATION, reach, ["write", "admin"]);
    await save(["read", "write"], connectionId);
    expect(await requested()).toEqual(["admin"]);
    await save(["read", "write", "admin"], connectionId);
    expect(await requested()).toEqual([]);
  });

  describe("the owner's notice", () => {
    const notices = () =>
      db
        .select({
          recipientId: notifications.recipientId,
          spaceId: notifications.spaceId,
          payload: notifications.payload,
          readAt: notifications.readAt,
        })
        .from(notifications)
        .where(eq(notifications.type, "connection_scopes_requested"));

    it("tells the owner once a demand gains a scope, one unread notice per connection", async () => {
      await recordRequestedScopes(connectionId, INTEGRATION, reach, ["write"]);
      await until(async () => (await notices()).length === 1);
      expect(await notices()).toEqual([
        {
          recipientId: ctx.user.id,
          spaceId: ctx.defaultSpaceId,
          payload: {
            packageId: INTEGRATION,
            integration_name: "Mail",
            connection_id: connectionId,
            label: expect.any(String),
          },
          readAt: null,
        },
      ]);
      // A wider demand while the notice is unread stacks nothing.
      await recordRequestedScopes(connectionId, INTEGRATION, reach, ["admin"]);
      await settle();
      expect(await notices()).toHaveLength(1);
      // Read, then asked again for a new scope: a new notice.
      await db.update(notifications).set({ readAt: new Date() });
      await recordRequestedScopes(connectionId, INTEGRATION, reach, ["delete"]);
      await until(async () => (await notices()).length === 2);
      // Read again, then asked only for scopes it already demands or holds: nothing new to say.
      await db.update(notifications).set({ readAt: new Date() });
      await recordRequestedScopes(connectionId, INTEGRATION, reach, ["write", "read", "bad scope"]);
      await settle();
      expect(await notices()).toHaveLength(2);
    });

    it("is read once a reconnect settles the whole demand, not before", async () => {
      await recordRequestedScopes(connectionId, INTEGRATION, reach, ["write", "admin"]);
      await until(async () => (await notices()).length === 1);
      await save(["read", "write"], connectionId);
      expect((await notices())[0]!.readAt).toBeNull();
      await save(["read", "write", "admin"], connectionId);
      expect((await notices())[0]!.readAt).not.toBeNull();
    });
  });
});
