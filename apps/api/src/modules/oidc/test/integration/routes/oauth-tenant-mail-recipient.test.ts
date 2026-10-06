// SPDX-License-Identifier: Apache-2.0

/**
 * A space's own SMTP transport is controlled by whoever holds
 * `space-settings:write` there. An auth mail is a credential: it may leave
 * through that transport only for a recipient of that space.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { prefixedId } from "@appstrate/db/ids";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { _resetCacheForTesting } from "@appstrate/env";
import { user as userTable, session as sessionTable, spaces } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { createTestContext, createTestUser } from "../../../../../../test/helpers/auth.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  captureMails,
  enableSmtpForSuite,
  firstLink,
} from "../../../../../../test/helpers/smtp.ts";
import { AUTHORITATIVE_PENDING_CLIENT_HEADER } from "../../../services/pending-client-cookie.ts";
import {
  createClient,
  deleteClient,
  updateClient,
  _resetClientCache,
} from "../../../services/oauth-admin.ts";
import {
  upsertSmtpConfig,
  _clearSmtpCacheForTesting,
  _setSmtpSpy,
  type SpiedSmtpSend,
} from "../../../services/smtp.ts";
import oidcModule from "../../../index.ts";

const app = getTestApp({ modules: [oidcModule] });

/** A space whose admin runs the mail server, and a client of that space. */
async function spaceWithOwnSmtp(): Promise<{ spaceId: string; clientId: string; qs: string }> {
  const ctx = await createTestContext({ orgSlug: `tenant-${crypto.randomUUID().slice(0, 8)}` });
  const spaceId = prefixedId("spc");
  await db.insert(spaces).values({
    id: spaceId,
    orgId: ctx.orgId,
    name: "Tenant",
    createdBy: ctx.user.id,
  });
  const client = await createClient({
    level: "space",
    name: "Tenant app",
    redirectUris: ["https://tenant.example.com/oauth/callback"],
    referencedSpaceId: spaceId,
    allowSignup: true,
  });
  await upsertSmtpConfig(spaceId, {
    host: "__test_json__",
    port: 587,
    username: "u",
    pass: "p",
    fromAddress: `no-reply@${spaceId}.test`,
    fromName: "Tenant",
  });
  return {
    spaceId,
    clientId: client.clientId,
    qs: `?client_id=${encodeURIComponent(client.clientId)}&state=s`,
  };
}

async function submitEmail(path: string, qs: string, email: string): Promise<Response> {
  const page = await app.request(`${path}${qs}`);
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  return app.request(`${path}${qs}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: `_csrf=${csrf}&email=${encodeURIComponent(email)}`,
  });
}

describe("OIDC per-space SMTP — who a tenant transport may write to", () => {
  enableSmtpForSuite();

  const savedAdmins = process.env.AUTH_PLATFORM_ADMIN_EMAILS;
  let mails: SpiedSmtpSend[] = [];

  beforeEach(async () => {
    await truncateAll();
    _resetClientCache();
    _clearSmtpCacheForTesting();
    mails = [];
    _setSmtpSpy((m) => mails.push(m));
  });

  afterEach(() => {
    _setSmtpSpy(null);
    if (savedAdmins === undefined) delete process.env.AUTH_PLATFORM_ADMIN_EMAILS;
    else process.env.AUTH_PLATFORM_ADMIN_EMAILS = savedAdmins;
    _resetCacheForTesting();
  });

  afterAll(() => {
    getTestApp();
  });

  it("sends no magic link for a platform account", async () => {
    const { qs } = await spaceWithOwnSmtp();
    const victim = await createTestUser({ emailVerified: true });

    const res = await submitEmail("/api/oauth/magic-link", qs, victim.email);

    expect(res.status).toBe(200);
    expect(mails).toHaveLength(0);
  });

  it("sends no password-reset link for a platform account", async () => {
    const { qs } = await spaceWithOwnSmtp();
    const victim = await createTestUser({ emailVerified: true });

    const res = await submitEmail("/api/oauth/forgot-password", qs, victim.email);

    expect(res.status).toBe(200);
    expect(mails).toHaveLength(0);
  });

  it("sends no magic link for an address the environment names, account or not", async () => {
    const { qs } = await spaceWithOwnSmtp();
    process.env.AUTH_PLATFORM_ADMIN_EMAILS = "ops@acme.test";
    _resetCacheForTesting();

    const res = await submitEmail("/api/oauth/magic-link", qs, "ops@acme.test");

    expect(res.status).toBe(200);
    expect(mails).toHaveLength(0);
    expect(await db.select().from(userTable).where(eq(userTable.email, "ops@acme.test"))).toEqual(
      [],
    );
  });

  describe("a link issued for a free address, opened once a platform account holds it", () => {
    async function openLinkAfter(change: (clientId: string) => Promise<unknown>) {
      const { clientId, qs } = await spaceWithOwnSmtp();
      const email = `later-${crypto.randomUUID()}@acme.test`;
      await submitEmail("/api/oauth/magic-link", qs, email);
      const link = new URL(/href="([^"]+)"/.exec(mails[0]!.html)![1]!.replaceAll("&amp;", "&"));
      const account = await createTestUser({ email, emailVerified: true });
      await change(clientId);

      const res = await app.request(`/api/auth/magic-link/verify${link.search}`);

      // Refused as a closed sign-up is, so the link's holder learns nothing.
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe(
        "signup_disabled",
      );
      expect(res.headers.getSetCookie().join(";")).not.toContain("session_token");
      expect(
        await db.select().from(sessionTable).where(eq(sessionTable.userId, account.id)),
      ).toHaveLength(1);
    }

    it("does not sign that account in", async () => {
      await openLinkAfter(async () => {});
    });

    it("nor after the client was deleted", async () => {
      await openLinkAfter((clientId) => deleteClient(clientId));
    });

    it("nor after the client was disabled", async () => {
      await openLinkAfter((clientId) => updateClient(clientId, { disabled: true }));
    });
  });

  describe("a dashboard magic link asked with a space's pending-client cookie still in the browser", () => {
    const savedClosed = process.env.AUTH_DISABLE_SIGNUP;

    afterEach(() => {
      if (savedClosed === undefined) delete process.env.AUTH_DISABLE_SIGNUP;
      else process.env.AUTH_DISABLE_SIGNUP = savedClosed;
      _resetCacheForTesting();
    });

    /** Visit the space's hosted sign-in, then ask the dashboard for a link and open it. */
    async function openDashboardLink(email: string, extraHeaders: Record<string, string> = {}) {
      const { qs } = await spaceWithOwnSmtp();
      const visit = await app.request(`/api/oauth/login${qs}`);
      const cookie = visit.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      expect(cookie).toContain("oidc_pending_client");
      const sent = await captureMails(async () => {
        await app.request("/api/auth/sign-in/magic-link", {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie, ...extraHeaders },
          body: JSON.stringify({ email, callbackURL: "/" }),
        });
      });
      return app.request(`/api/auth/magic-link/verify${firstLink(sent[0]!).search}`);
    }

    const realmOf = async (email: string) =>
      (await db.select().from(userTable).where(eq(userTable.email, email)))[0]?.realm;

    it("signs a platform user in", async () => {
      const account = await createTestUser({ emailVerified: true });

      const res = await openDashboardLink(account.email);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).not.toContain("error=");
      expect(res.headers.getSetCookie().join(";")).toContain("session_token");
    });

    it("creates a new address as a platform account", async () => {
      const email = `new-${crypto.randomUUID()}@acme.test`;

      await openDashboardLink(email);

      expect(await realmOf(email)).toBe("platform");
    });

    it("creates nothing when platform sign-up is closed", async () => {
      process.env.AUTH_DISABLE_SIGNUP = "true";
      _resetCacheForTesting();
      const email = `new-${crypto.randomUUID()}@acme.test`;

      await openDashboardLink(email);

      expect(await realmOf(email)).toBeUndefined();
    });

    it("is not bound to the space by a marker the caller sends itself", async () => {
      const email = `new-${crypto.randomUUID()}@acme.test`;

      await openDashboardLink(email, { [AUTHORITATIVE_PENDING_CLIENT_HEADER]: "1" });

      expect(await realmOf(email)).toBe("platform");
    });
  });

  it("still sends one to an end-user of that space, and to a new address", async () => {
    const { spaceId, qs } = await spaceWithOwnSmtp();
    const member = `member-${crypto.randomUUID()}@tenant.test`;
    await db.insert(userTable).values({
      id: crypto.randomUUID(),
      email: member,
      name: "Member",
      emailVerified: true,
      realm: `end_user:${spaceId}`,
    });

    await submitEmail("/api/oauth/magic-link", qs, member);
    await submitEmail("/api/oauth/magic-link", qs, `new-${crypto.randomUUID()}@tenant.test`);
    await submitEmail("/api/oauth/forgot-password", qs, member);

    expect(mails.map((m) => m.source)).toEqual(["per-space", "per-space", "per-space"]);
  });
});
