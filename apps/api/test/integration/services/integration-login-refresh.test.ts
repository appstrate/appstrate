// SPDX-License-Identifier: Apache-2.0
/**
 * A declarative `connect.login` that keeps its inputs (`persist_login_secret`) logs in again when
 * its session is rejected or expires (#1818), through the one refresh decision
 * (`refreshConnectionCredential`). The login target is a real loopback HTTP server that mints a
 * new session cookie on every accepted login.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import {
  decryptCredentialInputsToStringMap,
  decryptCredentialsToStringMap,
} from "@appstrate/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { apiIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { allowLoopbackOAuthEgress } from "../../helpers/strict-authorization-server.ts";
import { fieldsConnect } from "../../helpers/connect-surfaces.ts";
import type { AfpsManifestAuth } from "../../../src/services/integration-manifest-helpers.ts";
import {
  refreshConnectionCredential,
  type RefreshTrigger,
} from "../../../src/services/integration-token-refresh.ts";
import { readCredentialRevision } from "../../../src/services/integration-connections.ts";

const INTEGRATION_ID = "@myorg/legacy-app";
const USERNAME = "alice@example.com";
const PASSWORD = "p&ss=w+rd %x";

let server: ReturnType<typeof Bun.serve>;
let restoreEgress: () => void;
/** The password the target accepts; changing it simulates a password changed upstream. */
let acceptedPassword = PASSWORD;
let failing = false;
let logins = 0;

beforeAll(() => {
  restoreEgress = allowLoopbackOAuthEgress();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const form = new URLSearchParams(await req.text());
      if (failing) return new Response("maintenance", { status: 503 });
      if (form.get("username") !== USERNAME || form.get("password") !== acceptedPassword) {
        return new Response("no", { status: 401 });
      }
      logins += 1;
      return new Response("ok", { headers: { "Set-Cookie": `sid=session-${logins}; Path=/` } });
    },
  });
});

afterAll(() => {
  server.stop(true);
  restoreEgress();
});

function loginManifest(persist: boolean): IntegrationManifest {
  return apiIntegrationManifest({
    name: INTEGRATION_ID,
    auths: {
      session: {
        type: "custom",
        authorizedUris: [`${server.url.origin}/**`],
        credentialFields: ["username", "password"],
        connect: {
          login: {
            request: {
              method: "POST",
              url: `${server.url.origin}/login`,
              content_type: "application/x-www-form-urlencoded",
              body: "username={{username}}&password={{password}}",
            },
            success_criteria: [{ condition: "$statusCode == 200" }],
            outputs: { sid: { from: "cookie", name: "sid" } },
          },
          ...(persist
            ? { _meta: { "dev.appstrate/connect": { persist_login_secret: true } } }
            : {}),
        },
        delivery: { http: { in: "header", name: "Cookie", value: "sid={$credential.sid}" } },
      },
    },
  }) as IntegrationManifest;
}

/** The password field is a secret: the username alone names the connection. */
function withPasswordField(manifest: IntegrationManifest): IntegrationManifest {
  const auth = manifest.auths!.session as unknown as {
    credentials: { schema: { properties: Record<string, Record<string, unknown>> } };
  };
  auth.credentials.schema.properties.password = { type: "string", format: "password" };
  return manifest;
}

describe("connect.login session renewal", () => {
  let ctx: TestContext;
  let manifest: IntegrationManifest;

  async function connect(persist: boolean): Promise<string> {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    manifest = withPasswordField(loginManifest(persist));
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest,
    });
    const res = await fieldsConnect(ctx, INTEGRATION_ID, "session", {
      username: USERNAME,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { id: string }).id;
  }

  async function row(id: string) {
    const [found] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, id));
    return found!;
  }

  async function refresh(id: string, trigger: RefreshTrigger) {
    const current = await row(id);
    return refreshConnectionCredential({
      connection: { ...current, credentialRevision: (await readCredentialRevision(id))! },
      integrationId: INTEGRATION_ID,
      manifest,
      authDef: manifest.auths!.session as AfpsManifestAuth,
      scope: { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      actor: { type: "user", id: ctx.user.id },
      trigger,
    });
  }

  const REJECTED: RefreshTrigger = { kind: "rejected", revision: null };

  beforeEach(async () => {
    await flushRedis();
    acceptedPassword = PASSWORD;
    failing = false;
    logins = 0;
  });

  it("keeps the inputs it opts into, and names the connection after the username", async () => {
    const id = await connect(true);

    const stored = await row(id);
    expect(decryptCredentialInputsToStringMap(stored.credentialsEncrypted)).toEqual({
      username: USERNAME,
      password: PASSWORD,
    });
    expect(decryptCredentialsToStringMap(stored.credentialsEncrypted)).toEqual({
      sid: "session-1",
    });
    expect(stored.label).toBe("al****.com");
  });

  it("logs in again on a rejected session, keeping the inputs", async () => {
    const id = await connect(true);

    const outcome = await refresh(id, REJECTED);

    expect(outcome).toMatchObject({ status: "refreshed", fields: { sid: "session-2" } });
    const stored = await row(id);
    expect(decryptCredentialsToStringMap(stored.credentialsEncrypted)).toEqual({
      sid: "session-2",
    });
    expect(decryptCredentialInputsToStringMap(stored.credentialsEncrypted).password).toBe(PASSWORD);
  });

  it("logs in again before a declared expiry, and not before it is near", async () => {
    const id = await connect(true);
    const expiring: RefreshTrigger = { kind: "expiring" };

    await db
      .update(integrationConnections)
      .set({ expiresAt: new Date(Date.now() + 24 * 3600_000) })
      .where(eq(integrationConnections.id, id));
    expect(await refresh(id, expiring)).toEqual({ status: "kept" });

    await db
      .update(integrationConnections)
      .set({ expiresAt: new Date(Date.now() + 1000) })
      .where(eq(integrationConnections.id, id));
    expect(await refresh(id, expiring)).toMatchObject({
      status: "refreshed",
      fields: { sid: "session-2" },
    });
  });

  it("flags the connection when the service now refuses the kept credentials", async () => {
    const id = await connect(true);
    acceptedPassword = "changed upstream";

    expect(await refresh(id, REJECTED)).toMatchObject({
      status: "dead",
      cause: "connection_flagged",
    });
    expect((await row(id)).needsReconnection).toBe(true);
  });

  it("counts a service that cannot complete the login, without flagging it at once", async () => {
    const id = await connect(true);
    failing = true;

    expect(await refresh(id, REJECTED)).toMatchObject({
      status: "retry",
      cause: "upstream_transient",
    });
    expect((await row(id)).needsReconnection).toBe(false);
  });

  it("keeps no inputs and cannot log in again without the opt-in", async () => {
    const id = await connect(false);

    expect(decryptCredentialInputsToStringMap((await row(id)).credentialsEncrypted)).toEqual({});
    expect(await refresh(id, REJECTED)).toMatchObject({ cause: "unrefreshable" });
    expect(logins).toBe(1);
  });
});
