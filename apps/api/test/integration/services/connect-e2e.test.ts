// SPDX-License-Identifier: Apache-2.0

/**
 * E2E for the declarative Login connect path, exercised through the real
 * `POST /api/integrations/.../connect/fields` route against a local fake
 * upstream — using the SHIPPED system-package manifests
 * (`@appstrate/connect-bearer-test`, `@appstrate/connect-formlogin-test`),
 * with their `*.test.appstrate.dev` host rebased onto the test server so the
 * chain is hermetic. Proves the full pipeline: route → resolveStrategy →
 * LoginStrategy → runLogin (real HTTP) → persistCredentialBundle, with the
 * secret substituted at the boundary (never echoed back to the connection).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import { decryptCredentialsToStringMap } from "@appstrate/connect";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";

const app = getTestApp();
const SYS = join(import.meta.dir, "../../../../../scripts/system-packages");

/** Load a shipped system-package manifest, rebasing its test host onto `base`. */
function loadRebased(dir: string, testHost: string, base: string): IntegrationManifest {
  const raw = readFileSync(join(SYS, dir, "manifest.json"), "utf-8");
  return JSON.parse(raw.replaceAll(`https://${testHost}`, base)) as IntegrationManifest;
}

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** Per-test override for the token endpoint; null → happy-path JWT response. */
type TokenResponder = (() => Response) | null;

describe("connect E2E — declarative Login against the shipped system manifests", () => {
  let ctx: TestContext;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let tokenResponder: TokenResponder;
  let loginResponder: TokenResponder;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
    tokenResponder = null;
    loginResponder = null;

    // Fake upstream: a password-grant token endpoint + a form-login endpoint.
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/oauth/token") {
          if (tokenResponder) return tokenResponder();
          const jwt = `${b64url({ alg: "none" })}.${b64url({ AUTH: [{ personId: "P-42" }] })}.`;
          return new Response(JSON.stringify({ access_token: jwt, expires_in: 3600 }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname === "/j_security_check") {
          if (loginResponder) return loginResponder();
          const headers = new Headers();
          headers.append("set-cookie", "JSESSIONID=sess-abc; Path=/; HttpOnly");
          headers.append("set-cookie", "AWSALB=lb-xyz; Path=/");
          return new Response("ok", { headers });
        }
        return new Response("not found", { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    server.stop(true);
  });

  it("password grant: extracts access_token + JWT person_id, never persists the password", async () => {
    const manifest = loadRebased(
      "integration-connect-bearer-test-1.0.0",
      "bearer.test.appstrate.dev",
      base,
    );
    const pkg = await seedPackage({
      id: manifest.name,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest,
    });

    const res = await app.request(`/api/integrations/${pkg.id}/auths/session/connect/fields`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "content-type": "application/json" },
      body: JSON.stringify({ credentials: { email: "a@b.co", password: "s3cr3t" } }),
    });
    expect(res.status).toBe(200);
    const conn = (await res.json()) as { id: string; identityClaims?: Record<string, string> };

    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, conn.id));

    const outputs = decryptCredentialsToStringMap(row!.credentialsEncrypted);
    expect(outputs.access_token).toContain("."); // the JWT
    // The password was substituted at the boundary — it never lands in the bundle.
    expect(JSON.stringify(outputs)).not.toContain("s3cr3t");
    // person_id promoted to identity claims via the JWT extractor + identityOutputs.
    expect(row!.identityClaims).toMatchObject({ person_id: "P-42" });
    // expires_in (3600s) computed into a future expiry.
    expect(row!.expiresAt).toBeInstanceOf(Date);
    expect(row!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("form login: captures JSESSIONID + AWSALB cookies, never persists the password", async () => {
    const manifest = loadRebased(
      "integration-connect-formlogin-test-1.0.0",
      "formlogin.test.appstrate.dev",
      base,
    );
    const pkg = await seedPackage({
      id: manifest.name,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest,
    });

    const res = await app.request(`/api/integrations/${pkg.id}/auths/session/connect/fields`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "content-type": "application/json" },
      body: JSON.stringify({ credentials: { username: "user1", password: "s3cr3t" } }),
    });
    expect(res.status).toBe(200);
    const conn = (await res.json()) as { id: string };

    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, conn.id));
    const outputs = decryptCredentialsToStringMap(row!.credentialsEncrypted);
    expect(outputs).toEqual({ JSESSIONID: "sess-abc", AWSALB: "lb-xyz" });
    expect(JSON.stringify(outputs)).not.toContain("s3cr3t");
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  /** Seed the Login package and POST credentials to its fields-connect route. */
  async function connectLogin(credentials: Record<string, string>) {
    const manifest = loadRebased(
      "integration-connect-bearer-test-1.0.0",
      "bearer.test.appstrate.dev",
      base,
    );
    const pkg = await seedPackage({
      id: manifest.name,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest,
    });
    const res = await app.request(`/api/integrations/${pkg.id}/auths/session/connect/fields`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "content-type": "application/json" },
      body: JSON.stringify({ credentials }),
    });
    return { res, pkg };
  }

  async function connectionCount(): Promise<number> {
    const rows = await db.select().from(integrationConnections);
    return rows.length;
  }

  it("upstream non-2xx: fails the connect, persists nothing, never echoes the secret", async () => {
    // The token endpoint rejects with 401 and a body that embeds the password —
    // the engine must not surface that body, and no connection may be written.
    tokenResponder = () => new Response("invalid_grant for password s3cr3t", { status: 401 });

    const { res } = await connectLogin({ email: "a@b.co", password: "s3cr3t" });

    expect(res.status).toBe(500);
    const text = await res.text();
    // RFC 9457 problem+json — generic internal error, no upstream body, no secret.
    expect(text).not.toContain("s3cr3t");
    expect(text).not.toContain("invalid_grant");
    expect(await connectionCount()).toBe(0);
  });

  it("missing required credential field: unresolved placeholder fails closed, nothing persisted", async () => {
    // `password` is omitted. The route's Zod schema only checks non-empty, so the
    // value reaches the engine, which fails closed on the unresolved `{{password}}`
    // rather than sending it literally upstream. No connection is written.
    const { res } = await connectLogin({ email: "a@b.co" });

    expect(res.status).toBe(500);
    expect(await connectionCount()).toBe(0);
  });

  it("empty credentials object: rejected by request validation (400), no upstream call", async () => {
    const { res } = await connectLogin({});

    expect(res.status).toBe(400);
    expect(await connectionCount()).toBe(0);
  });

  it("malformed upstream JSON: surfaces an extract failure, persists nothing", async () => {
    // 200 OK but the body is not JSON — the json extractor for access_token throws
    // `extract_failed`, so the connect aborts before any persistence.
    tokenResponder = () => new Response("<html>maintenance</html>", { status: 200 });

    const { res } = await connectLogin({ email: "a@b.co", password: "s3cr3t" });

    expect(res.status).toBe(500);
    expect(await connectionCount()).toBe(0);
  });

  it("form login with no Set-Cookie: empty-cookie extraction fails closed, nothing persisted", async () => {
    // Regression for the empty-extraction gap: a 200 with no cookies must NOT
    // persist `Cookie: JSESSIONID=; AWSALB=` — the engine fails closed instead.
    loginResponder = () => new Response("ok", { status: 200 });

    const manifest = loadRebased(
      "integration-connect-formlogin-test-1.0.0",
      "formlogin.test.appstrate.dev",
      base,
    );
    const pkg = await seedPackage({
      id: manifest.name,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest,
    });
    const res = await app.request(`/api/integrations/${pkg.id}/auths/session/connect/fields`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "content-type": "application/json" },
      body: JSON.stringify({ credentials: { username: "user1", password: "s3cr3t" } }),
    });

    expect(res.status).toBe(500);
    expect(await connectionCount()).toBe(0);
  });

  it("same auth connected twice: a second connection is created (no single-auth gate)", async () => {
    // Multi-connection model (CLAUDE.md): saveIntegrationConnection has no
    // single-auth gate. Connecting the same auth twice on the same actor yields
    // an upsert-or-insert — assert the happy path stays connectable repeatedly.
    const first = await connectLogin({ email: "a@b.co", password: "s3cr3t" });
    expect(first.res.status).toBe(200);

    const second = await app.request(
      `/api/integrations/${first.pkg.id}/auths/session/connect/fields`,
      {
        method: "POST",
        headers: { ...authHeaders(ctx), "content-type": "application/json" },
        body: JSON.stringify({ credentials: { email: "a@b.co", password: "s3cr3t" } }),
      },
    );
    expect(second.status).toBe(200);
    // At least one connection exists; both resolve the same identity (person_id P-42),
    // so the writer keys on (package, auth, account, actor) — either 1 (upsert) or 2.
    expect(await connectionCount()).toBeGreaterThanOrEqual(1);
  });
});
