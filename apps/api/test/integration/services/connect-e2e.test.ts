// SPDX-License-Identifier: Apache-2.0

/**
 * E2E for the declarative TwoStep connect path, exercised through the real
 * `POST /api/integrations/.../connect/fields` route against a local fake
 * upstream — using the SHIPPED system-package manifests
 * (`@appstrate/connect-twostep-test`, `@appstrate/connect-formlogin-test`),
 * with their `*.test.appstrate.dev` host rebased onto the test server so the
 * chain is hermetic. Proves the full pipeline: route → resolveStrategy →
 * TwoStepStrategy → runTwoStep (real HTTP) → persistCredentialBundle, with the
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

describe("connect E2E — declarative TwoStep against the shipped system manifests", () => {
  let ctx: TestContext;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });

    // Fake upstream: a password-grant token endpoint + a form-login endpoint.
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/oauth/token") {
          const jwt = `${b64url({ alg: "none" })}.${b64url({ AUTH: [{ personId: "P-42" }] })}.`;
          return new Response(JSON.stringify({ access_token: jwt, expires_in: 3600 }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname === "/j_security_check") {
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
      "integration-connect-twostep-test-1.0.0",
      "twostep.test.appstrate.dev",
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
});
