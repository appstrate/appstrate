// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import {
  applications,
  browserConnectionBindings,
  browserConnectionAttempts,
  browserProfileDeletions,
  integrationConnections,
} from "@appstrate/db/schema";

import type { BrowserProfileManager } from "../../../src/services/browser-profile-manager.ts";
import {
  acquireBrowserSessionLease,
  BrowserSessionBusyError,
  createBrowserConnectionAttempt,
  finalizeBrowserConnectionBinding,
  purgeFinishedBrowserConnectionAttempts,
  releaseBrowserSessionLease,
  setBrowserAttemptInteraction,
} from "../../../src/services/browser-connection-state.ts";
import type { BrowserConnectExecutor } from "../../../src/services/connect/browser-strategy.ts";
import { deleteIntegrationConnection } from "../../../src/services/integration-connections.ts";
import { drainBrowserProfileDeletions } from "../../../src/services/browser-profile-deletions.ts";
import { enqueueBrowserProfileDeletion } from "../../../src/services/browser-profile-deletions.ts";
import { getTestApp } from "../../helpers/app.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  connectToolBlock,
  httpHeaderDelivery,
  localIntegrationManifest,
} from "../../helpers/integration-manifests.ts";
import { seedPackage } from "../../helpers/seed.ts";

const PACKAGE_ID = "@myorg/companion-browser";
const jobs: Array<() => Promise<void>> = [];

const profileManager: BrowserProfileManager = {
  async allocate({ provider, attemptId }) {
    return provider === "browser-use-cloud"
      ? "018f0c67-98ab-7def-8123-123456789abc"
      : `process-${attemptId}`;
  },
  async remove() {},
};

const browserExecutor: BrowserConnectExecutor = {
  async run(execution) {
    const browserState = execution.inputs.browser_state;
    if (typeof browserState !== "string") throw new Error("missing browser state");
    return {
      outputs: { browser_state: browserState },
      proof: { kind: "companion-route-test", succeeded: true },
      identityClaims: { marketplace: "companion-test" },
    };
  },
};

const app = getTestApp({
  modules: [],
  integrationsRouter: {
    browserConnectExecutor: browserExecutor,
    browserProfileManager: profileManager,
    browserProvider: "process",
    dispatchBackground: (job) => jobs.push(job),
  },
});

function manifest() {
  return localIntegrationManifest({
    name: PACKAGE_ID,
    serverName: "@appstrate/companion-browser-driver",
    auths: {
      session: {
        type: "custom",
        authorizedUris: [
          "https://leboncoin.fr/**",
          "https://www.leboncoin.fr/**",
          "https://auth.leboncoin.fr/**",
        ],
        credentialFields: ["browser_state"],
        connect: connectToolBlock({
          tool: "acquire_session",
          runAt: "link",
          produces: ["browser_state"],
          browserExecutor: { sessionMode: "exportable" },
          companionStartUrl: "https://www.leboncoin.fr/compte/part/mes-annonces",
        }),
        delivery: httpHeaderDelivery({ name: "X-Browser-State", field: "browser_state" }),
      },
    },
  });
}

function pageCookie(response: Response): string {
  const match = response.headers.get("set-cookie")?.match(/appstrate_connect=([^;]+)/);
  if (!match) throw new Error("connect page cookie was not set");
  return `appstrate_connect=${match[1]}`;
}

async function openHostedConnect(
  ctx: TestContext,
  connectionId?: string,
): Promise<{ cookie: string; csrf: string }> {
  const minted = await app.request(
    `/api/integrations/${PACKAGE_ID}/auths/session/connect/session`,
    {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(connectionId ? { connection_id: connectionId } : {}),
    },
  );
  const { connect_url: connectUrl } = (await minted.json()) as { connect_url: string };
  const token = new URL(connectUrl).searchParams.get("token")!;
  const start = await app.request(
    `/api/integrations/connect/start?token=${encodeURIComponent(token)}`,
    { redirect: "manual" },
  );
  const cookie = pageCookie(start);
  const contextResponse = await app.request("/api/integrations/connect/context", {
    headers: { Cookie: cookie },
  });
  const context = (await contextResponse.json()) as {
    csrf: string;
    companion: { available: boolean; target_provider: string };
  };
  expect(context.companion.available).toBe(true);
  expect(["browser-use-cloud", "process"]).toContain(context.companion.target_provider);
  return { cookie, csrf: context.csrf };
}

async function createVerifiedProcessConnection(ctx: TestContext): Promise<{
  connection: typeof integrationConnections.$inferSelect;
  binding: typeof browserConnectionBindings.$inferSelect;
}> {
  const { cookie, csrf } = await openHostedConnect(ctx);
  const created = await app.request("/api/integrations/connect/companion/attempts", {
    method: "POST",
    headers: { Cookie: cookie, "x-connect-csrf": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ target_provider: "process" }),
  });
  const payload = (await created.json()) as { companion_url: string };
  const link = new URL(payload.companion_url);
  const endpoint = new URL(link.searchParams.get("endpoint")!);
  const token = link.searchParams.get("token")!;
  const handoff = await app.request(`${endpoint.pathname}/handoff`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      browser_state: JSON.stringify({ version: 1, cookies: [], origins: [] }),
    }),
  });
  expect(handoff.status).toBe(202);
  const job = jobs.shift();
  if (!job) throw new Error("companion provisioning was not dispatched");
  await job();
  const [connection] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.integrationId, PACKAGE_ID));
  if (!connection) throw new Error("verified companion connection was not persisted");
  const [binding] = await db
    .select()
    .from(browserConnectionBindings)
    .where(eq(browserConnectionBindings.connectionId, connection.id));
  if (!binding) throw new Error("verified browser binding was not persisted");
  return { connection, binding };
}

describe("local browser companion handoff", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    jobs.length = 0;
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedPackage({
      id: PACKAGE_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest(),
    });
  });

  it("persists a verified connection and provider binding asynchronously", async () => {
    const { cookie, csrf } = await openHostedConnect(ctx);
    const created = await app.request("/api/integrations/connect/companion/attempts", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "x-connect-csrf": csrf,
      },
      body: JSON.stringify({ target_provider: "process" }),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toContain("no-store");
    const payload = (await created.json()) as { attempt_id: string; companion_url: string };
    const companionUrl = new URL(payload.companion_url);
    const endpoint = companionUrl.searchParams.get("endpoint")!;
    const token = companionUrl.searchParams.get("token")!;

    const claimed = await app.request(new URL(endpoint).pathname, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(claimed.status).toBe(200);
    const claimedBody = (await claimed.json()) as {
      status: string;
      start_url: string;
      allowed_origins: string[];
    };
    expect(claimedBody.status).toBe("claimed");
    expect(claimedBody.start_url).toContain("leboncoin.fr/compte/");
    expect(claimedBody.allowed_origins).toEqual([
      "https://auth.leboncoin.fr",
      "https://leboncoin.fr",
      "https://www.leboncoin.fr",
    ]);

    const browserState = JSON.stringify({
      version: 1,
      cookies: [
        {
          name: "datadome",
          value: "test-cookie",
          domain: ".www.leboncoin.fr",
          path: "/",
          secure: true,
          httpOnly: false,
          expires: -1,
        },
      ],
      origins: [
        {
          origin: "https://www.leboncoin.fr",
          localStorage: [{ name: "session", value: "test-value" }],
        },
      ],
    });
    const handedOff = await app.request(`${new URL(endpoint).pathname}/handoff`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ browser_state: browserState }),
    });
    expect(handedOff.status).toBe(202);
    expect(jobs).toHaveLength(1);
    await jobs[0]!();

    const completed = await app.request(new URL(endpoint).pathname, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(completed.status).toBe(200);
    expect(((await completed.json()) as { status: string }).status).toBe("complete");
    const [attempt] = await db
      .select()
      .from(browserConnectionAttempts)
      .where(eq(browserConnectionAttempts.id, payload.attempt_id));
    expect(attempt?.handoffEncrypted).toBeNull();
    expect(attempt?.tokenHash).not.toBe(token);
    const connections = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, PACKAGE_ID));
    expect(connections).toHaveLength(1);
    const bindings = await db
      .select()
      .from(browserConnectionBindings)
      .where(eq(browserConnectionBindings.connectionId, connections[0]!.id));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.provider).toBe("process");

    await deleteIntegrationConnection(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      connections[0]!.id,
      { type: "user", id: ctx.user.id },
    );
    expect(await db.select().from(browserConnectionBindings)).toHaveLength(0);
    expect(await db.select().from(browserProfileDeletions)).toEqual([
      expect.objectContaining({ provider: "process", profileRef: bindings[0]!.profileRef }),
    ]);
    expect(await drainBrowserProfileDeletions(profileManager)).toEqual({ removed: 1, failed: 0 });
  });

  it("keeps observer polling passive and surfaces a closed local browser immediately", async () => {
    const { cookie, csrf } = await openHostedConnect(ctx);
    const created = await app.request("/api/integrations/connect/companion/attempts", {
      method: "POST",
      headers: { Cookie: cookie, "x-connect-csrf": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ target_provider: "process" }),
    });
    const payload = (await created.json()) as { companion_url: string };
    const link = new URL(payload.companion_url);
    const endpoint = new URL(link.searchParams.get("endpoint")!);
    const token = link.searchParams.get("token")!;
    const headers = { Authorization: `Bearer ${token}` };

    const observedPending = await app.request(`${endpoint.pathname}?observe=1`, { headers });
    expect(observedPending.status).toBe(200);
    expect(((await observedPending.json()) as { status: string }).status).toBe("pending");

    const claimed = await app.request(endpoint.pathname, { headers });
    expect(((await claimed.json()) as { status: string }).status).toBe("claimed");

    const failed = await app.request(`${endpoint.pathname}/failure`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "closed" }),
    });
    expect(failed.status).toBe(202);
    expect(await failed.json()).toEqual({ accepted: true });

    const observedFailure = await app.request(`${endpoint.pathname}?observe=1`, { headers });
    expect(observedFailure.status).toBe(200);
    expect(await observedFailure.json()).toEqual(
      expect.objectContaining({
        status: "failed",
        error_code: "BROWSER_COMPANION_CLOSED",
      }),
    );
    expect(await db.select().from(browserProfileDeletions)).toHaveLength(1);
  });

  it("does not let a late companion failure abort accepted handoff state", async () => {
    const { cookie, csrf } = await openHostedConnect(ctx);
    const created = await app.request("/api/integrations/connect/companion/attempts", {
      method: "POST",
      headers: { Cookie: cookie, "x-connect-csrf": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ target_provider: "process" }),
    });
    const payload = (await created.json()) as { companion_url: string };
    const link = new URL(payload.companion_url);
    const endpoint = new URL(link.searchParams.get("endpoint")!);
    const token = link.searchParams.get("token")!;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const handoff = await app.request(`${endpoint.pathname}/handoff`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        browser_state: JSON.stringify({ version: 1, cookies: [], origins: [] }),
      }),
    });
    expect(handoff.status).toBe(202);

    const lateFailure = await app.request(`${endpoint.pathname}/failure`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: "closed" }),
    });
    expect(lateFailure.status).toBe(202);
    const observed = await app.request(`${endpoint.pathname}?observe=1`, { headers });
    expect(((await observed.json()) as { status: string }).status).toBe("state_received");
  });

  it("serializes profile use with fenced, expiring leases", async () => {
    const { cookie, csrf } = await openHostedConnect(ctx);
    const created = await app.request("/api/integrations/connect/companion/attempts", {
      method: "POST",
      headers: { Cookie: cookie, "x-connect-csrf": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ target_provider: "process" }),
    });
    const payload = (await created.json()) as { companion_url: string };
    const link = new URL(payload.companion_url);
    const endpoint = new URL(link.searchParams.get("endpoint")!);
    const token = link.searchParams.get("token")!;
    await app.request(`${endpoint.pathname}/handoff`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        browser_state: JSON.stringify({ version: 1, cookies: [], origins: [] }),
      }),
    });
    await jobs[0]!();
    const [binding] = await db.select().from(browserConnectionBindings).limit(1);
    const now = new Date(Date.now() + 1_000);
    const first = await acquireBrowserSessionLease({
      bindingId: binding!.id,
      ownerId: "run:first",
      ttlMs: 10_000,
      now,
    });
    await expect(
      acquireBrowserSessionLease({
        bindingId: binding!.id,
        ownerId: "run:second",
        ttlMs: 10_000,
        now: new Date(now.getTime() + 1_000),
      }),
    ).rejects.toBeInstanceOf(BrowserSessionBusyError);
    const second = await acquireBrowserSessionLease({
      bindingId: binding!.id,
      ownerId: "run:second",
      ttlMs: 10_000,
      now: new Date(now.getTime() + 11_000),
    });
    expect(second.fencingToken).toBe(first.fencingToken + 1);
    expect(await releaseBrowserSessionLease(first)).toBe(false);
    expect(await releaseBrowserSessionLease(second)).toBe(true);
    await expect(
      acquireBrowserSessionLease({
        bindingId: binding!.id,
        ownerId: "run:stale-plan",
        ttlMs: 10_000,
        expectedStateVersion: binding!.stateVersion + 1,
      }),
    ).rejects.toThrow("BROWSER_STATE_CONFLICT");
  });

  it("does not replace a provider profile while a run holds its binding lease", async () => {
    const { connection, binding } = await createVerifiedProcessConnection(ctx);
    const lease = await acquireBrowserSessionLease({
      bindingId: binding.id,
      ownerId: "run:active",
      ttlMs: 60_000,
      expectedStateVersion: binding.stateVersion,
    });
    const { cookie, csrf } = await openHostedConnect(ctx, connection.id);
    const created = await app.request("/api/integrations/connect/companion/attempts", {
      method: "POST",
      headers: { Cookie: cookie, "x-connect-csrf": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ target_provider: "process" }),
    });
    const { attempt_id: attemptId } = (await created.json()) as { attempt_id: string };
    await db
      .update(browserConnectionAttempts)
      .set({ status: "provisioning" })
      .where(eq(browserConnectionAttempts.id, attemptId));
    await expect(
      finalizeBrowserConnectionBinding({ attemptId, connectionId: connection.id }),
    ).rejects.toBeInstanceOf(BrowserSessionBusyError);
    const [unchanged] = await db
      .select()
      .from(browserConnectionBindings)
      .where(eq(browserConnectionBindings.id, binding.id));
    expect(unchanged?.profileRef).toBe(binding.profileRef);
    expect(unchanged?.stateVersion).toBe(binding.stateVersion);
    expect(await releaseBrowserSessionLease(lease)).toBe(true);
  });

  it("defers remote profile deletion until an active run lease expires", async () => {
    const { connection, binding } = await createVerifiedProcessConnection(ctx);
    const lease = await acquireBrowserSessionLease({
      bindingId: binding.id,
      ownerId: "run:active-delete",
      ttlMs: 60_000,
      expectedStateVersion: binding.stateVersion,
    });
    await deleteIntegrationConnection(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      connection.id,
      { type: "user", id: ctx.user.id },
    );
    const [deletion] = await db.select().from(browserProfileDeletions);
    expect(deletion?.profileRef).toBe(binding.profileRef);
    expect(deletion?.nextAttemptAt.getTime()).toBe(lease.expiresAt.getTime());
    expect(await releaseBrowserSessionLease(lease)).toBe(false);
  });

  it("keeps cascade-driven binding cleanup behind the active lease", async () => {
    const { connection, binding } = await createVerifiedProcessConnection(ctx);
    const now = new Date();
    const lease = await acquireBrowserSessionLease({
      bindingId: binding.id,
      ownerId: "run:cascade-test",
      ttlMs: 120_000,
      now,
    });
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connection.id));
    const [deletion] = await db.select().from(browserProfileDeletions);
    expect(deletion?.profileRef).toBe(binding.profileRef);
    expect(deletion?.nextAttemptAt.getTime()).toBe(lease.expiresAt.getTime());
  });

  it("queues an abandoned attempt profile when its application cascades", async () => {
    const { attempt } = await createBrowserConnectionAttempt(
      {
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        actor: { type: "user", id: ctx.user.id },
        integrationId: PACKAGE_ID,
        authKey: "session",
        targetProvider: "process",
      },
      profileManager,
    );
    await db.delete(applications).where(eq(applications.id, ctx.defaultAppId));
    const [deletion] = await db.select().from(browserProfileDeletions);
    expect(deletion?.provider).toBe("process");
    expect(deletion?.profileRef).toBe(attempt.profileRef);
  });

  it("does not delete a bound profile when completed attempt metadata is purged", async () => {
    const { binding } = await createVerifiedProcessConnection(ctx);
    const [completed] = await db
      .select({ id: browserConnectionAttempts.id })
      .from(browserConnectionAttempts)
      .where(eq(browserConnectionAttempts.status, "complete"));
    if (!completed) throw new Error("completed browser attempt was not persisted");
    await db
      .delete(browserConnectionAttempts)
      .where(eq(browserConnectionAttempts.id, completed.id));
    expect(await db.select().from(browserProfileDeletions)).toHaveLength(0);
    expect(
      await db
        .select()
        .from(browserConnectionBindings)
        .where(eq(browserConnectionBindings.id, binding.id)),
    ).toHaveLength(1);
  });

  it("rejects off-allowlist browser state before dispatch", async () => {
    const { cookie, csrf } = await openHostedConnect(ctx);
    const created = await app.request("/api/integrations/connect/companion/attempts", {
      method: "POST",
      headers: { Cookie: cookie, "x-connect-csrf": csrf, "Content-Type": "application/json" },
      body: "{}",
    });
    const payload = (await created.json()) as { companion_url: string };
    const link = new URL(payload.companion_url);
    const endpoint = new URL(link.searchParams.get("endpoint")!);
    const token = link.searchParams.get("token")!;
    const response = await app.request(`${endpoint.pathname}/handoff`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        browser_state: JSON.stringify({
          version: 1,
          cookies: [{ name: "stolen", value: "x", domain: "evil.example" }],
          origins: [],
        }),
      }),
    });
    expect(response.status).toBe(400);
    expect(jobs).toHaveLength(0);
  });

  it("encrypts a connection-scoped cloud routing snapshot", async () => {
    const { attempt: createdAttempt } = await createBrowserConnectionAttempt(
      {
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        actor: { type: "user", id: ctx.user.id },
        integrationId: PACKAGE_ID,
        authKey: "session",
        targetProvider: "browser-use-cloud",
        proxy: { kind: "country", countryCode: "fr" },
      },
      profileManager,
    );
    const [storedAttempt] = await db
      .select()
      .from(browserConnectionAttempts)
      .where(eq(browserConnectionAttempts.id, createdAttempt.id));
    expect(storedAttempt?.proxyConfigEncrypted).toStartWith("v1:");
    expect(storedAttempt?.proxyConfigEncrypted).not.toContain("countryCode");
  });

  it("does not let the hosted client override operator provider routing", async () => {
    const { cookie, csrf } = await openHostedConnect(ctx);
    const response = await app.request("/api/integrations/connect/companion/attempts", {
      method: "POST",
      headers: { Cookie: cookie, "x-connect-csrf": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ target_provider: "browser-use-cloud" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        detail: "Requested browser provider does not match operator policy",
      }),
    );
  });

  it("does not expose attempts without the bearer", async () => {
    const response = await app.request(
      "/api/integrations/connect/companion/attempts/00000000-0000-4000-8000-000000000000",
    );
    expect(response.status).toBe(401);
  });

  it("does not let a late provider callback resurrect an expired attempt", async () => {
    const { cookie, csrf } = await openHostedConnect(ctx);
    const created = await app.request("/api/integrations/connect/companion/attempts", {
      method: "POST",
      headers: { Cookie: cookie, "x-connect-csrf": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ target_provider: "process" }),
    });
    const { attempt_id: attemptId } = (await created.json()) as { attempt_id: string };
    await db
      .update(browserConnectionAttempts)
      .set({ status: "expired", expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(browserConnectionAttempts.id, attemptId));
    await expect(
      setBrowserAttemptInteraction(attemptId, "https://live.browser-use.com/session/test"),
    ).rejects.toThrow("invalid or expired");
    const [attempt] = await db
      .select()
      .from(browserConnectionAttempts)
      .where(eq(browserConnectionAttempts.id, attemptId));
    expect(attempt?.status).toBe("expired");
    expect(attempt?.interactionEncrypted).toBeNull();
    expect(
      await purgeFinishedBrowserConnectionAttempts(new Date(Date.now() + 120_000), 60_000),
    ).toBe(1);
  });

  it("retains failed cloud profile deletions with exponential retry metadata", async () => {
    const profileRef = "018f0c67-98ab-7def-8123-123456789abc";
    await enqueueBrowserProfileDeletion("browser-use-cloud", profileRef);
    const now = new Date(Date.now() + 1_000);
    const failingManager: BrowserProfileManager = {
      async allocate() {
        throw new Error("unused");
      },
      async remove() {
        throw new Error("provider unavailable");
      },
    };
    expect(await drainBrowserProfileDeletions(failingManager, { now })).toEqual({
      removed: 0,
      failed: 1,
    });
    const [queued] = await db.select().from(browserProfileDeletions);
    expect(queued).toMatchObject({
      profileRef,
      attempts: 1,
      lastError: "provider unavailable",
    });
    expect(queued?.nextAttemptAt.getTime()).toBe(now.getTime() + 30_000);
    expect(await drainBrowserProfileDeletions(failingManager, { now })).toEqual({
      removed: 0,
      failed: 0,
    });
  });
});
