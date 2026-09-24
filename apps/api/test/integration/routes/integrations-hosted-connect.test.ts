// SPDX-License-Identifier: Apache-2.0
/**
 * Integration tests for the hosted connect portal (issue #769).
 *
 * Covers the unified, auth-type-agnostic connect surface:
 *  - mint a connect session (`POST .../connect/session`) → `connect_url`
 *  - dispatch (`GET /connect/start`) — page cookie + single-use jti + redirect
 *  - render context (`GET /connect/context`) — page cookie, no secret
 *  - submit (`POST /connect/submit`) — page cookie + CSRF, persists credentials
 *  - reconnect in place via `connection_id`
 *
 * OAuth dispatch internals are covered by the existing `/connect/oauth2` tests;
 * here we assert only that mint works for an oauth2 auth.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestOrg,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedApiKey, seedPackage, seedSpace } from "../../helpers/seed.ts";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  auditEvents,
  integrationConnections,
  integrationOauthClients,
  packages,
} from "@appstrate/db/schema";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type { AppstrateModule, AuthResolution } from "@appstrate/core/module";
import {
  buildConnectUrl,
  connectClaimsFor,
} from "../../../src/services/connect/connect-session.ts";
import { generateOpenSshEd25519PrivateKey } from "../../../src/lib/openssh-key.ts";
import {
  _setSystemPackagesForTesting,
  type SystemPackageEntry,
} from "../../../src/services/system-packages.ts";

const app = getTestApp();

function apiKeyManifest(name = "@myorg/gmail"): IntegrationManifest {
  return {
    type: "integration",
    schema_version: "0.1",
    name,
    version: "0.1.0",
    display_name: "Gmail",
    description: "Gmail integration",
    icon: "logos:google-gmail",
    source: { kind: "local", server: { name, version: "^0.1.0" } },
    auths: {
      api: {
        type: "api_key",
        authorized_uris: ["https://gmail.googleapis.com/**"],
        credentials: { schema: { type: "object", properties: { api_key: { type: "string" } } } },
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.api_key}",
          },
        },
      },
    },
  } as unknown as IntegrationManifest;
}

async function seedIntegration(orgId: string, manifest: IntegrationManifest) {
  return seedPackage({
    id: manifest.name,
    orgId,
    type: "integration",
    source: "local",
    draftManifest: manifest,
  });
}

/** Extract the `appstrate_connect` cookie value from a Set-Cookie header. */
function readSetCookie(res: Response): string | null {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const m = raw.match(/appstrate_connect=([^;]+)/);
  return m ? m[1]! : null;
}

async function mintSession(
  ctx: TestContext,
  packageId: string,
  authKey: string,
  body: Record<string, unknown> = {},
): Promise<string> {
  const res = await app.request(`/api/integrations/${packageId}/auths/${authKey}/connect/session`, {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { connect_url: string; expiresAt: string };
  // RFC 3339, not epoch ms: the canonical `expiresAt` spelling carries a string.
  expect(new Date(json.expiresAt).toISOString()).toBe(json.expiresAt);
  const url = new URL(json.connect_url);
  const token = url.searchParams.get("token");
  expect(token).toBeTruthy();
  return token!;
}

describe("hosted connect portal — mint", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, apiKeyManifest("@myorg/gmail"));
  });

  it("mints a connect_url for an api_key auth", async () => {
    const res = await app.request("/api/integrations/@myorg/gmail/auths/api/connect/session", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { connect_url: string; expiresAt: string };
    expect(json.connect_url).toContain("/api/integrations/connect/start?token=");
  });

  it("404s when the auth key does not exist", async () => {
    const res = await app.request("/api/integrations/@myorg/gmail/auths/nope/connect/session", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

describe("hosted connect portal — dispatch + submit", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, apiKeyManifest("@myorg/gmail"));
  });

  it("dispatches a non-oauth token to the hosted form and sets a page cookie", async () => {
    const token = await mintSession(ctx, "@myorg/gmail", "api");
    const start = await app.request(
      `/api/integrations/connect/start?token=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toBe("/connect");
    expect(readSetCookie(start)).toBeTruthy();
  });

  it("rejects a reused token (single-use jti)", async () => {
    const token = await mintSession(ctx, "@myorg/gmail", "api");
    const first = await app.request(
      `/api/integrations/connect/start?token=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );
    expect(first.status).toBe(302);
    const second = await app.request(
      `/api/integrations/connect/start?token=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );
    expect(second.status).toBe(410);
  });

  it("rejects an invalid token", async () => {
    const res = await app.request("/api/integrations/connect/start?token=garbage", {
      redirect: "manual",
    });
    expect(res.status).toBe(410);
  });

  it("400s when the token is missing", async () => {
    const res = await app.request("/api/integrations/connect/start", { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  it("serves render context (no secret) and accepts a submit with CSRF", async () => {
    const token = await mintSession(ctx, "@myorg/gmail", "api");
    const start = await app.request(
      `/api/integrations/connect/start?token=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );
    const cookie = `appstrate_connect=${readSetCookie(start)}`;

    const ctxRes = await app.request("/api/integrations/connect/context", {
      headers: { Cookie: cookie },
    });
    expect(ctxRes.status).toBe(200);
    const context = (await ctxRes.json()) as {
      packageId: string;
      auth_key: string;
      display_name: string;
      auth: { type: string };
      csrf: string;
    };
    expect(context.packageId).toBe("@myorg/gmail");
    expect(context.auth_key).toBe("api");
    expect(context.display_name).toBe("Gmail");
    expect(context.auth.type).toBe("api_key");
    expect(context.csrf).toBeTruthy();

    const submit = await app.request("/api/integrations/connect/submit", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "x-connect-csrf": context.csrf,
      },
      body: JSON.stringify({ credentials: { api_key: "AKIA-SECRET" } }),
    });
    expect(submit.status).toBe(200);
    const result = (await submit.json()) as { ok: boolean; connection: { id: string } };
    expect(result.ok).toBe(true);

    const rows = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, result.connection.id));
    expect(rows).toHaveLength(1);
  });

  it("rejects a submit without the CSRF header", async () => {
    const token = await mintSession(ctx, "@myorg/gmail", "api");
    const start = await app.request(
      `/api/integrations/connect/start?token=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );
    const cookie = `appstrate_connect=${readSetCookie(start)}`;
    const submit = await app.request("/api/integrations/connect/submit", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { api_key: "AKIA-SECRET" } }),
    });
    expect(submit.status).toBe(400);
  });

  it("404s context/submit without a page cookie", async () => {
    const ctxRes = await app.request("/api/integrations/connect/context");
    expect(ctxRes.status).toBe(404);
  });

  it("reconnects in place when connection_id is supplied — no duplicate", async () => {
    // First connect.
    const token1 = await mintSession(ctx, "@myorg/gmail", "api");
    const start1 = await app.request(
      `/api/integrations/connect/start?token=${encodeURIComponent(token1)}`,
      { redirect: "manual" },
    );
    const cookie1 = `appstrate_connect=${readSetCookie(start1)}`;
    const c1 = (await (
      await app.request("/api/integrations/connect/context", { headers: { Cookie: cookie1 } })
    ).json()) as { csrf: string };
    const created = (await (
      await app.request("/api/integrations/connect/submit", {
        method: "POST",
        headers: { Cookie: cookie1, "Content-Type": "application/json", "x-connect-csrf": c1.csrf },
        body: JSON.stringify({ credentials: { api_key: "AKIA-FIRST" } }),
      })
    ).json()) as { connection: { id: string } };

    // Reconnect: mint with connection_id.
    const token2 = await mintSession(ctx, "@myorg/gmail", "api", {
      connection_id: created.connection.id,
    });
    const start2 = await app.request(
      `/api/integrations/connect/start?token=${encodeURIComponent(token2)}`,
      { redirect: "manual" },
    );
    const cookie2 = `appstrate_connect=${readSetCookie(start2)}`;
    const c2 = (await (
      await app.request("/api/integrations/connect/context", { headers: { Cookie: cookie2 } })
    ).json()) as { csrf: string; connection_id: string };
    expect(c2.connection_id).toBe(created.connection.id);
    const renewed = (await (
      await app.request("/api/integrations/connect/submit", {
        method: "POST",
        headers: { Cookie: cookie2, "Content-Type": "application/json", "x-connect-csrf": c2.csrf },
        body: JSON.stringify({ credentials: { api_key: "AKIA-RENEWED" } }),
      })
    ).json()) as { connection: { id: string } };
    expect(renewed.connection.id).toBe(created.connection.id);

    const all = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, "@myorg/gmail"));
    expect(all).toHaveLength(1);

    // The page cookie carries the principal, not a session: the trail must
    // still name the user, and tell the renewal apart from the creation.
    const trail = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, created.connection.id))
      .orderBy(auditEvents.id);
    expect(trail.map((r) => [r.action, r.actorType, r.actorId, r.spaceId])).toEqual([
      ["integration.connection.created", "user", ctx.user.id, ctx.defaultSpaceId],
      ["integration.connection.reconnected", "user", ctx.user.id, ctx.defaultSpaceId],
    ]);
    expect(trail[0]!.after).toMatchObject({ packageId: "@myorg/gmail", authKey: "api" });
    expect(JSON.stringify(trail)).not.toContain("AKIA");
  });
});

/**
 * Classic (confidential) oauth2 auth — needs a pre-registered client per
 * space. Same shape as the `google` auth in `integrations.test.ts`.
 */
function oauthManifest(name = "@myorg/gsuite"): IntegrationManifest {
  return {
    type: "integration",
    schema_version: "0.1",
    name,
    version: "0.1.0",
    display_name: "Google Workspace",
    description: "Google Workspace integration",
    icon: "logos:google",
    source: { kind: "local", server: { name, version: "^0.1.0" } },
    auths: {
      google: {
        type: "oauth2",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
        default_scopes: ["openid", "email"],
        authorized_uris: ["https://www.googleapis.com/**"],
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.access_token}",
          },
        },
      },
    },
  } as unknown as IntegrationManifest;
}

/**
 * Remote MCP oauth2 auth with no pre-registered client (auto-DCR path). The
 * `.invalid` TLD (RFC 6761) makes discovery fail fast, so provisioning fails
 * without a live authorization server — same fixture as `integrations.test.ts`.
 */
function remoteMcpManifest(name = "@myorg/remote-mcp"): IntegrationManifest {
  return {
    type: "integration",
    schema_version: "0.1",
    name,
    version: "1.0.0",
    display_name: "Remote MCP",
    description: "Remote MCP integration with MCP-spec auto-DCR",
    source: {
      kind: "remote",
      remote: { url: "https://mcp.invalid/mcp", transport: "streamable-http" },
    },
    auths: {
      oauth: {
        type: "oauth2",
        issuer: "https://mcp.invalid",
        token_endpoint_auth_method: "none",
        default_scopes: ["read", "write"],
        authorized_uris: ["https://mcp.invalid/**"],
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.access_token}",
          },
        },
        _meta: { "dev.appstrate/oauth": { scope_separator: " " } },
      },
    },
  } as unknown as IntegrationManifest;
}

async function startConnect(token: string): Promise<Response> {
  return app.request(`/api/integrations/connect/start?token=${encodeURIComponent(token)}`, {
    redirect: "manual",
  });
}

describe("hosted connect portal — oauth2 dispatch without a client (issues #1263, #1345)", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, oauthManifest("@myorg/gsuite"));
  });

  it("renders a permanent 403, not a generic 502 — and not the operator detail", async () => {
    const token = await mintSession(ctx, "@myorg/gsuite", "google");
    const res = await startConnect(token);
    // Status parity with `POST …/connect/oauth2` on the same space, and wording
    // that says "permanent": no "try again", which is what a 502 would invite.
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Ask an administrator");
    expect(html).not.toContain("Please try again");
    // This link survives its own refusal (next case), so the advice must point
    // back at it — and must NOT be the wording the burned branch gets.
    expect(html).toContain("open this link again");
    expect(html).not.toContain("request a new connection link");
    // The `detail` that names the remedy is written for an operator, and this
    // route has no session (issue #1345) — it belongs in the log line only.
    expect(html).not.toContain("Administrator must register OAuth client credentials");
  });

  it("keeps the link reusable: a second click is the same 403, not 'already used'", async () => {
    const token = await mintSession(ctx, "@myorg/gsuite", "google");
    expect((await startConnect(token)).status).toBe(403);
    const again = await startConnect(token);
    expect(again.status).toBe(403);
    expect(await again.text()).not.toContain("already been used");
  });

  it("lets the same link succeed once an administrator registers a client", async () => {
    const token = await mintSession(ctx, "@myorg/gsuite", "google");
    expect((await startConnect(token)).status).toBe(403);

    const registered = await app.request(
      "/api/integrations/@myorg/gsuite/auths/google/oauth-clients",
      {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: "abc", client_secret: "shh" }),
      },
    );
    expect(registered.status).toBe(201);

    // The very same link now dispatches to the provider — no re-mint.
    const res = await startConnect(token);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("client_id")).toBe("abc");

    // …and the successful click is the one that burns it.
    expect((await startConnect(token)).status).toBe(410);
  });

  it("keeps the auto-provisioning failure's own prose off a remote MCP popup", async () => {
    await seedIntegration(ctx.orgId, remoteMcpManifest("@myorg/remote-mcp"));
    const token = await mintSession(ctx, "@myorg/remote-mcp", "oauth");
    const res = await startConnect(token);
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("Ask an administrator");
    // This click burns the link (next case), so reopening it answers 410: the
    // only advice that works is a re-mint.
    expect(html).toContain("request a new connection link");
    expect(html).not.toContain("open this link again");
    // This `detail` embeds the authorization server's OWN message verbatim
    // (`resolveConnectClient` renders `provisioningFailure.message` as-is), so
    // it is upstream-controlled text on a session-less page. Log only.
    expect(html).not.toContain("Could not automatically provision an OAuth client");
    expect(html).not.toContain("dynamic client registration");
  });

  it("burns a remote MCP link: its refusal follows a registration attempt (issue #1344)", async () => {
    // The mirror image of the reusable classic 403 above. Client acquisition
    // for this auth happens AT the authorization server — discovery, then an
    // RFC 7591 registration POST — so by the time the refusal lands, the click
    // has already spent outbound calls and may have left an orphan client
    // registered upstream. A link that survived its own refusal would replay
    // that on every click, for its whole TTL, on a route with no session.
    await seedIntegration(ctx.orgId, remoteMcpManifest("@myorg/remote-mcp"));
    const token = await mintSession(ctx, "@myorg/remote-mcp", "oauth");
    expect((await startConnect(token)).status).toBe(403);

    const again = await startConnect(token);
    expect(again.status).toBe(410);
    expect(await again.text()).toContain("already been used");
  });

  it("never names the row or the env var when a client_secret cannot be decrypted", async () => {
    // The ciphertext no longer opens (key rotated without re-encrypt, or
    // corruption): `has_client_secret` still reads true from the column while
    // the decrypt yields "", and `assertConnectClientUsable` refuses the
    // client with a 403 whose detail names the client row's uuid and
    // `CONNECTION_ENCRYPTION_KEY`. That is the disclosure of issue #1345.
    const registered = await app.request(
      "/api/integrations/@myorg/gsuite/auths/google/oauth-clients",
      {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: "abc", client_secret: "shh" }),
      },
    );
    expect(registered.status).toBe(201);
    const clientId = ((await registered.json()) as { id: string }).id;
    await db
      .update(integrationOauthClients)
      .set({ clientSecretEncrypted: "not-a-valid-envelope" })
      .where(eq(integrationOauthClients.id, clientId));

    const res = await startConnect(await mintSession(ctx, "@myorg/gsuite", "google"));
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("Ask an administrator");
    for (const internal of ["CONNECTION_ENCRYPTION_KEY", "cannot be decrypted", clientId]) {
      expect(html).not.toContain(internal);
    }
  });
});

/**
 * The completion payload the popup broadcasts, as the browser would read it.
 *
 * The page inlines it as a single `var detail = {…};` statement of flat JSON
 * (`buildIntegrationConnectCompletion` produces no nested object), so the line
 * itself is the whole payload.
 */
function completionDetail(html: string): Record<string, unknown> {
  const match = /^\s*var detail = (\{.*\});$/m.exec(html);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!) as Record<string, unknown>;
}

describe("hosted connect portal — error completions are addressed (issue #1346)", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, apiKeyManifest("@myorg/gmail"));
    await seedIntegration(ctx.orgId, oauthManifest("@myorg/gsuite"));
  });

  // A completion naming NOTHING is delivered to every waiting surface by
  // contract (`completionMatches`), and both carriers fan out — so an
  // unaddressed failure on a Gmail link drives an open ClickUp card into an
  // error naming Gmail.
  it("names the package on the OAuth-begin refusal", async () => {
    const res = await startConnect(await mintSession(ctx, "@myorg/gsuite", "google"));
    expect(res.status).toBe(403);
    expect(completionDetail(await res.text())).toMatchObject({
      ok: false,
      packageId: "@myorg/gsuite",
    });
  });

  it("names the package when the link has already been used", async () => {
    const token = await mintSession(ctx, "@myorg/gmail", "api");
    expect((await startConnect(token)).status).toBe(302);
    const again = await startConnect(token);
    expect(again.status).toBe(410);
    const detail = completionDetail(await again.text());
    expect(detail).toMatchObject({ ok: false, packageId: "@myorg/gmail" });
  });

  it("names the package when the integration is gone", async () => {
    const token = await mintSession(ctx, "@myorg/gmail", "api");
    await db.delete(packages).where(eq(packages.id, "@myorg/gmail"));
    const res = await startConnect(token);
    expect(res.status).toBe(410);
    expect(completionDetail(await res.text())).toMatchObject({
      ok: false,
      packageId: "@myorg/gmail",
    });
  });

  // The other half of the rule: the two pages that run BEFORE the claims are
  // decoded resolved no package and no state, so they stay context-less — that
  // is the case `completionMatches`'s permissive tail exists for, and widening
  // it is not what this fix does.
  it("leaves the pre-claims pages context-less", async () => {
    for (const query of ["", "?token=not-a-token"]) {
      const res = await app.request(`/api/integrations/connect/start${query}`, {
        redirect: "manual",
      });
      const detail = completionDetail(await res.text());
      expect(detail.packageId).toBeUndefined();
      expect(detail.state).toBeUndefined();
    }
  });
});

describe("hosted connect portal — a fault while resolving scopes (issue #1352)", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, oauthManifest("@myorg/gsuite"));
  });

  /**
   * Mint a capability token straight from claims. The mint route validates
   * `connection_id` against the caller's rows, and this case needs claims it
   * would refuse: a malformed id makes `getCurrentScopesGranted`'s row read
   * throw at the database the way a real fault there would. That read runs
   * after the jti is burned and before anything is sent upstream — the window
   * this test pins.
   */
  function mintUnreadableConnection(): string {
    const { connectUrl } = buildConnectUrl(
      connectClaimsFor({
        scope: { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
        actor: { type: "user", id: ctx.user.id },
        packageId: "@myorg/gsuite",
        authKey: "google",
        connectionId: "not-a-uuid",
      }),
    );
    return new URL(connectUrl).searchParams.get("token")!;
  }

  it("renders the popup error page, not raw problem+json", async () => {
    const res = await startConnect(mintUnreadableConnection());
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Please try again");
    // Addressed like every other completion this handler emits (issue #1346).
    expect(completionDetail(html)).toMatchObject({ ok: false, packageId: "@myorg/gsuite" });
  });

  it("hands the link back — this click spent nothing", async () => {
    const token = mintUnreadableConnection();
    expect((await startConnect(token)).status).toBe(500);
    const again = await startConnect(token);
    expect(again.status).toBe(500);
    expect(await again.text()).not.toContain("already been used");
  });
});

/** The package id the provisioning table names — the only one it provisions. */
const SSH_ID = "@appstrate/ssh";

/**
 * Credential PROVISIONING at the ROUTE level.
 *
 * The provisioner's own guards are unit-tested; what only this level can show
 * is WHICH routes run it. There are two doors onto `FieldsStrategy`: the
 * hosted form, which provisions, and the programmatic import, which does not
 * — and therefore refuses any name the platform mints for that auth.
 * The invariants the SSH integration relies on cannot live in the provisioner
 * alone: they live in `credentials.schema`, which both doors validate.
 */
async function sshManifest(name = SSH_ID): Promise<IntegrationManifest> {
  // Read the SHIPPED manifest rather than restating its schema here: the
  // constraints under test are the ones `@appstrate/ssh` actually carries, and
  // a local copy of them would stay green after someone deleted the originals.
  // Seeded as a row (`getTestApp()` skips the boot sync, see
  // `registerSshAsSystemPackage`); `name` rewrites the identifiers for a copy
  // under another id.
  const sources = join(import.meta.dir, "../../../../../scripts/system-packages");
  const dir = (await readdir(sources))
    .filter((d) => d.startsWith("integration-ssh-"))
    .sort()
    .at(-1);
  if (!dir) throw new Error("no integration-ssh-* source directory found");
  const manifest = JSON.parse(
    await readFile(join(sources, dir, "manifest.json"), "utf8"),
  ) as IntegrationManifest & { source: { server: { name: string } } };
  manifest.name = name;
  manifest.source.server.name = `${name}-mcp`;
  return manifest;
}

/**
 * Provisioning answers only for a loaded system package, and `getTestApp()`
 * skips the boot that fills the system registry — so a describe connecting the
 * SSH package registers its id for its own duration. Handed back afterwards:
 * the whole suite shares one process and one registry.
 */
function registerSshAsSystemPackage() {
  let restore: () => void;
  beforeAll(() => {
    restore = _setSystemPackagesForTesting(
      new Map([[SSH_ID, { packageId: SSH_ID } as SystemPackageEntry]]),
    );
  });
  afterAll(() => restore());
}

/**
 * What the hosted form actually asks for: everything except `private_key`,
 * which the platform mints and the render context therefore never offers.
 */
const SSH_FORM_FIELDS = {
  host: "ssh.example.test",
  port: "22",
  user: "agent",
  host_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5",
} as const;

/**
 * The same fields plus a well-formed key the CALLER holds: what the fields
 * route refuses for `@appstrate/ssh` and accepts for a copy under another id.
 */
const CALLER_KEYED_FIELDS = {
  ...SSH_FORM_FIELDS,
  private_key: generateOpenSshEd25519PrivateKey(),
};

/**
 * Mint a session, follow the dispatch, and come back with the page cookie +
 * CSRF nonce. `mint` is the mint body — `{ connection_id }` for a reconnect.
 */
async function openConnectForm(
  ctx: TestContext,
  packageId: string,
  authKey: string,
  mint: Record<string, unknown> = {},
) {
  const token = await mintSession(ctx, packageId, authKey, mint);
  const start = await app.request(
    `/api/integrations/connect/start?token=${encodeURIComponent(token)}`,
    { redirect: "manual" },
  );
  const cookie = `appstrate_connect=${readSetCookie(start)}`;
  const contextRes = await app.request("/api/integrations/connect/context", {
    headers: { Cookie: cookie },
  });
  const context = (await contextRes.json()) as { csrf: string };
  return { cookie, csrf: context.csrf };
}

/** The whole hosted-form round trip: open it, then post the credentials it asks for. */
async function submitConnectForm(
  ctx: TestContext,
  packageId: string,
  authKey: string,
  credentials: Record<string, unknown>,
  mint: Record<string, unknown> = {},
) {
  const { cookie, csrf } = await openConnectForm(ctx, packageId, authKey, mint);
  return app.request("/api/integrations/connect/submit", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "x-connect-csrf": csrf },
    body: JSON.stringify({ credentials }),
  });
}

describe("hosted connect portal — credential provisioning", () => {
  registerSshAsSystemPackage();
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, await sshManifest());
  });

  const submit = async (credentials: Record<string, unknown>) =>
    submitConnectForm(ctx, SSH_ID, "primary", credentials);

  const importFields = async (credentials: Record<string, unknown>) =>
    app.request(`/api/integrations/${SSH_ID}/auths/primary/connect/fields`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ credentials }),
    });

  /**
   * WHICH credentials the platform mints is answered once, in the provisioner
   * table, and the form learns it from the schema it is served — not from a
   * second list inside an immutable manifest. So the render context must be
   * the one place that answer reaches the browser.
   */
  it("serves a schema the form can render verbatim, minus what it mints", async () => {
    const { cookie } = await openConnectForm(ctx, SSH_ID, "primary");
    const res = await app.request("/api/integrations/connect/context", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      auth: {
        credentials: { schema: { properties: Record<string, unknown>; required: string[] } };
      };
    };
    const schema = body.auth.credentials.schema;
    // Asked for: exactly the four fields only the user can answer. The minted
    // one is gone from BOTH halves — left in `required` it would be a field
    // the form cannot satisfy.
    expect(Object.keys(schema.properties).sort()).toEqual(["host", "host_key", "port", "user"]);
    expect(schema.required).not.toContain("private_key");
    // And nothing secret rides along on the way.
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
  });

  /**
   * The provisioner runs INSIDE the submit route, so a target the runner could
   * never reach has to fail here — not be persisted as a connection whose
   * every run fails. This is also what proves the wiring: without it the bag
   * would simply be stored as sent.
   */
  it("refuses at the form a host the runner's egress would refuse", async () => {
    const res = await submit({ host: "10.1.2.3", user: "agent", port: "22" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/runs cannot reach this host/);

    const rows = await db.select().from(integrationConnections);
    expect(rows).toHaveLength(0);
  });

  /**
   * The programmatic import runs no provisioner, so a `private_key` arriving
   * there is one the CALLER made. Accepting it would have the platform render
   * a root install block for an attacker-held key — the whole point of minting
   * the pair. Any credential named in `provides` is refused at the door.
   */
  it("refuses a caller-supplied private_key on the programmatic import", async () => {
    const res = await importFields(CALLER_KEYED_FIELDS);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/private_key.*minted by the platform/);

    const rows = await db.select().from(integrationConnections);
    expect(rows).toHaveLength(0);
  });

  /**
   * The account name is the field whose shape the SSH runner depends on: it is
   * concatenated into ssh's destination argument, so an `-o`-shaped value
   * would be read as an option rather than a user. `credentials.schema` is
   * what bounds it, and the hosted form is the only door onto this auth.
   */
  it.each([
    ["an account name shaped like an ssh option", { user: "-oProxyCommand=x" }],
    ["a host shaped like an ssh option", { host: "-oProxyCommand=x" }],
    ["a host key that is not a public key line", { host_key: "not-a-key" }],
  ])("refuses %s on the hosted form", async (_label, override) => {
    const res = await submit({ ...SSH_FORM_FIELDS, ...override });
    expect(res.status).toBe(400);

    const rows = await db.select().from(integrationConnections);
    expect(rows).toHaveLength(0);
  });

  it("accepts a well-shaped bag on the hosted form and mints the key", async () => {
    // The positive control for the refusals above: same door, same fields, and
    // the only difference is that every value is in shape.
    const res = await submit(SSH_FORM_FIELDS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { handoff_steps?: Array<{ kind: string }> };
    // The user never typed a private key — the platform made one, and handed
    // back the install block for its public half.
    expect(body.handoff_steps?.map((s) => s.kind)).toEqual(["command", "value", "command"]);
  });

  /**
   * A reconnect re-runs the SAME form on the SAME target — after a repinned
   * host key, or a connection flagged for reconnection. The key the user
   * already authorized there must survive it: minting a second pair would
   * strand the installed line and leave every run failing until someone went
   * back and pasted the new block. So the provisioner reuses the key the
   * connection already holds.
   */
  it("keeps the installed key across a reconnect of the same connection", async () => {
    const first = await submit(SSH_FORM_FIELDS);
    expect(first.status).toBe(200);
    const created = (await first.json()) as {
      connection: { id: string };
      handoff_steps: Array<{ shell?: string }>;
    };

    const reconnected = await submitConnectForm(ctx, SSH_ID, "primary", SSH_FORM_FIELDS, {
      connection_id: created.connection.id,
    });
    expect(reconnected.status).toBe(200);
    const renewed = (await reconnected.json()) as {
      connection: { id: string };
      handoff_steps: Array<{ shell?: string }>;
    };
    expect(renewed.connection.id).toBe(created.connection.id);

    // The public half is the whole point: identical across both responses, so
    // the line already in `authorized_keys` still opens this connection.
    const publicKeyOf = (steps: Array<{ shell?: string }>) =>
      /restrict ssh-ed25519 ([A-Za-z0-9+/=]+)/.exec(String(steps[0]!.shell))![1]!;
    expect(publicKeyOf(renewed.handoff_steps)).toBe(publicKeyOf(created.handoff_steps));
  });
});

/**
 * The same manifest seeded under another package id. Provisioning is keyed by
 * package id and auth key in code, never read off the manifest, so a copy of
 * `@appstrate/ssh` gets no minted key and no root install block: its
 * `private_key` is an ordinary field the user must supply.
 */
describe("hosted connect portal — the same manifest under another package id", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, await sshManifest("@myorg/ssh-fork"));
  });

  it("serves the schema with private_key still asked for", async () => {
    const { cookie } = await openConnectForm(ctx, "@myorg/ssh-fork", "primary");
    const res = await app.request("/api/integrations/connect/context", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      auth: { credentials: { schema: { properties: Record<string, unknown> } } };
    };
    expect(Object.keys(body.auth.credentials.schema.properties)).toContain("private_key");
  });

  it("mints nothing on the hosted form: the missing private_key is refused", async () => {
    // The bag the SSH package's form accepts (see the positive control above):
    // here nothing fills `private_key`, so `required` refuses it.
    const res = await submitConnectForm(ctx, "@myorg/ssh-fork", "primary", SSH_FORM_FIELDS);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/declared schema:.*private_key/);

    const rows = await db.select().from(integrationConnections);
    expect(rows).toHaveLength(0);
  });

  it("accepts a caller-held private_key on the programmatic import", async () => {
    // The body `@appstrate/ssh` refuses as platform-minted: on a copy it is
    // an ordinary custom-auth bag.
    const res = await app.request(
      "/api/integrations/@myorg/ssh-fork/auths/primary/connect/fields",
      {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ credentials: CALLER_KEYED_FIELDS }),
      },
    );
    expect(res.status).toBe(200);

    const rows = await db.select().from(integrationConnections);
    expect(rows).toHaveLength(1);
  });
});

/**
 * An org-bound DELEGATE with NO pinned space — the `oauth2-dashboard` shape,
 * as `module-auth-strategy.test.ts` models it. It is the credential the
 * handoff's ORG check answers alone: an API key pins a space as well, so for
 * one of those the space check reaches the same verdict first. The bound org
 * rides a header so one strategy covers both a foreign and a matching org.
 */
let boundUser: { id: string; email: string; name: string } | null = null;

const orgBoundDelegate: AppstrateModule = {
  manifest: { id: "handoff-org-bound", name: "Handoff Org Bound", version: "1.0.0" },
  async init() {},
  authStrategies() {
    return [
      {
        id: "handoff-org-bound-delegate",
        async authenticate({ headers }) {
          const orgId = headers.get("x-test-bound-org");
          if (!orgId || !boundUser) return null;
          return {
            user: boundUser,
            orgId,
            orgRole: "admin",
            authMethod: "test-org-bound-delegate",
            principalKind: "delegate",
            // The handoff's ceiling, so only the binding can refuse.
            permissions: ["integrations:disconnect"],
          } satisfies AuthResolution;
        },
      },
    ];
  },
};

/** Its own app: a strategy is contributed by a module, and the default app loads none. */
const boundApp = getTestApp({ modules: [orgBoundDelegate] });

/**
 * What is due AT DELETION has to be available long after the screen that first
 * showed it: deleting a connection destroys the platform's half of a minted
 * credential and nothing else, so its public key stays authorized on the
 * customer's machine. That is the endpoint's whole job — the steps due at
 * creation belong to the submit response and are not re-served here.
 *
 * Nothing persists any of it: both halves are derived from the credential
 * bundle, because an `openssh-key-v1` container carries its own public half in
 * the clear and a stored copy could drift from the key it claims to remove.
 */
describe("me/connections/:id/handoff — the teardown half, derived", () => {
  registerSshAsSystemPackage();
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, await sshManifest());
    await seedIntegration(ctx.orgId, apiKeyManifest("@myorg/gmail"));
  });

  /** The only door onto a provisioning auth: the hosted form, which mints the key. */
  const connectSsh = async () => {
    const res = await submitConnectForm(ctx, SSH_ID, "primary", SSH_FORM_FIELDS);
    expect(res.status).toBe(200);
    return (await res.json()) as {
      connection: { id: string };
      handoff_steps: Array<Record<string, unknown>>;
    };
  };

  const handoffOf = async (connectionId: string) => {
    const res = await app.request(`/api/me/connections/${connectionId}/handoff`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { data: Array<Record<string, unknown>> };
  };

  it("returns the removal block, and nothing that was due at creation", async () => {
    const { connection, handoff_steps: steps } = await connectSsh();

    // Exactly the deferred subset of what the submit response carried, minus
    // the flag that selected it — rebuilt from the keyring alone, so the block
    // that removes the key cannot disagree with the one that installed it.
    const removal = steps.find((s) => s.deferred === true)!;
    const { data } = await handoffOf(connection.id);
    expect(data).toEqual([
      {
        kind: removal.kind,
        // The key a localised client translates on, carried by BOTH surfaces:
        // the teardown reads the same on the deletion screen as at creation.
        id: removal.id,
        label: removal.label,
        shell: removal.shell,
        note: removal.note,
      },
    ]);
    expect(data.every((s) => !("deferred" in s))).toBe(true);

    // The base64 of the key this connection actually holds, so the command
    // removes its line and no other — the property a stored copy could lose.
    const installBlock = String(steps[0]!.shell);
    const base64 = /restrict ssh-ed25519 ([A-Za-z0-9+/=]+)/.exec(installBlock)![1]!;
    expect(data[0]!.shell).toContain(`grep -vF '${base64}'`);
  });

  it("is empty for an auth that mints nothing", async () => {
    const res = await app.request("/api/integrations/@myorg/gmail/auths/api/connect/fields", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { api_key: "AKIA-SECRET" } }),
    });
    expect(res.status).toBe(200);
    const conn = (await res.json()) as { id: string };
    expect((await handoffOf(conn.id)).data).toEqual([]);
  });

  /**
   * Same non-disclosure as the DELETE beside it: a caller probing ids must not
   * be able to tell an unknown one from a not-owned one.
   */
  it.each([
    ["a malformed id", "not-a-uuid"],
    ["an unknown id", "11111111-2222-3333-4444-555555555555"],
  ])("answers an empty list for %s", async (_label, id) => {
    expect((await handoffOf(id)).data).toEqual([]);
  });

  it("refuses to derive one for someone else's connection", async () => {
    const { connection } = await connectSsh();

    const other = await createTestContext({ orgSlug: "otherorg" });
    const res = await app.request(`/api/me/connections/${connection.id}/handoff`, {
      headers: authHeaders(other),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
  });

  /**
   * This read DECRYPTS, so it is held to the presented credential's binding
   * exactly as the list and the delete beside it are: a credential issued in
   * one organization never has the platform open an envelope in another, even
   * when it authenticates as the connection's own owner.
   */
  describe("a bound credential stays inside its binding", () => {
    /** A second org for the SAME user, so ownership passes and only the binding can refuse. */
    const secondOrgFor = async (userId: string) =>
      (await createTestOrg(userId, { slug: `handoff-other-${crypto.randomUUID().slice(0, 8)}` }))
        .org.id;

    const handoffAs = async (connectionId: string, headers: Record<string, string>) => {
      const res = await app.request(`/api/me/connections/${connectionId}/handoff`, { headers });
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: unknown[] }).data;
    };

    /**
     * An API key pins a space as well as an org, so this pair is held by the
     * SPACE tier — the org tier below is what an org-only credential meets.
     */
    it("answers nothing to an API key issued in another org, and the block to one issued here", async () => {
      const { connection } = await connectSsh();
      const foreignOrgId = await secondOrgFor(ctx.user.id);
      const foreignSpace = await seedSpace({ orgId: foreignOrgId, name: "Foreign" });
      // Both hold the handoff's ceiling, so only the binding can refuse.
      const scopes = ["integrations:disconnect"];
      const foreign = await seedApiKey({
        orgId: foreignOrgId,
        spaceId: foreignSpace.id,
        createdBy: ctx.user.id,
        scopes,
      });
      const here = await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        scopes,
      });

      expect(await handoffAs(connection.id, { Authorization: `Bearer ${foreign.rawKey}` })).toEqual(
        [],
      );
      expect(
        await handoffAs(connection.id, { Authorization: `Bearer ${here.rawKey}` }),
      ).toHaveLength(1);
    });

    /**
     * The org tier on its own: this credential pins NO space, so nothing but
     * the org comparison stands between a foreign organization's token and a
     * decryption of its creator's key.
     */
    it("answers nothing to an org-bound token from another org, and the block to one from here", async () => {
      const { connection } = await connectSsh();
      boundUser = { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name };
      const foreignOrgId = await secondOrgFor(ctx.user.id);

      const boundHandoff = async (orgId: string) => {
        const res = await boundApp.request(`/api/me/connections/${connection.id}/handoff`, {
          headers: { "x-test-bound-org": orgId },
        });
        expect(res.status).toBe(200);
        return ((await res.json()) as { data: unknown[] }).data;
      };

      expect(await boundHandoff(foreignOrgId)).toEqual([]);
      expect(await boundHandoff(ctx.orgId)).toHaveLength(1);
    });
  });
});
