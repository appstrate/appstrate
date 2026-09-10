// SPDX-License-Identifier: Apache-2.0

/**
 * Scope-catalog enforcement on the two CALLER-FACING connect kickoffs
 * (`POST .../connect/oauth2`, `POST .../connect/session`), issue #1207.
 *
 * `body.scopes` is the only delta a caller contributes to the consent request —
 * defaults and already-granted scopes are computed server-side — and it used to
 * be validated as `z.array(z.string())` and nothing else. A scope the auth does
 * not advertise therefore travelled all the way to the provider's consent
 * screen and came back as an opaque `invalid_scope`, after the redirect, with
 * nothing naming the offending value. Now it is a 400 on `scopes` at the
 * kickoff.
 *
 * `GET /connect/start` is deliberately absent here: it replays the claims the
 * session mint signed, so the mint is the one place the check belongs.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { readConnectToken } from "../../../src/services/connect/connect-session.ts";

const app = getTestApp();
const INTEGRATION = "@myorg/gmail";

/**
 * Two oauth2 auths on purpose: `catalogued` advertises a closed scope set,
 * `open` advertises none. The pair is what separates "rejected because it is
 * undeclared" from "accepted because nothing is declared".
 */
function manifest(): IntegrationManifest {
  const oauth = (scopeCatalog?: { value: string; label: string }[]) => ({
    type: "oauth2",
    authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint: "https://oauth2.googleapis.com/token",
    default_scopes: ["openid"],
    ...(scopeCatalog ? { scope_catalog: scopeCatalog } : {}),
    authorized_uris: ["https://www.googleapis.com/**"],
    delivery: {
      http: {
        in: "header",
        name: "Authorization",
        prefix: "Bearer ",
        value: "{$credential.access_token}",
      },
    },
  });
  return {
    type: "integration",
    schema_version: "0.1",
    name: INTEGRATION,
    version: "0.1.0",
    display_name: "Gmail",
    description: "Gmail integration",
    source: { kind: "local", server: { name: INTEGRATION, version: "^0.1.0" } },
    auths: {
      catalogued: oauth([
        { value: "openid", label: "OpenID" },
        { value: "gmail.readonly", label: "Read mail" },
        { value: "gmail.send", label: "Send mail" },
      ]),
      open: oauth(),
    },
  } as unknown as IntegrationManifest;
}

/** Register the OAuth client the admin would have registered, so a valid kickoff reaches 200. */
async function registerClient(ctx: TestContext, authKey: string): Promise<void> {
  const res = await app.request(`/api/integrations/${INTEGRATION}/auths/${authKey}/oauth-clients`, {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: "abc", client_secret: "shh" }),
  });
  expect(res.status).toBe(201);
}

async function kickoff(
  ctx: TestContext,
  surface: "oauth2" | "session",
  authKey: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return await app.request(`/api/integrations/${INTEGRATION}/auths/${authKey}/connect/${surface}`, {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * What the kickoff actually asked consent for — accepting a scope set is only
 * half the contract, relaying it verbatim is the other half.
 *
 * The two surfaces expose it differently: `session` signs the caller's set into
 * the capability token's claims and computes no union at all (defaults ∪
 * already-granted happen later, at `/connect/start` redemption), while `oauth2`
 * hands the caller a provider URL it will redirect to itself, so its `scope`
 * query param already carries the union with the auth's `default_scopes`.
 * `undefined` = the surface asked for no scopes at all.
 */
async function requestedScopes(
  surface: "oauth2" | "session",
  res: Response,
): Promise<string[] | undefined> {
  if (surface === "session") {
    const { connect_url: connectUrl } = (await res.json()) as { connect_url: string };
    const token = new URL(connectUrl).searchParams.get("token");
    return readConnectToken(token!)?.scopes;
  }
  const { auth_url: authUrl } = (await res.json()) as { auth_url: string };
  const scope = new URL(authUrl).searchParams.get("scope");
  return scope === null ? undefined : scope.split(" ");
}

interface ProblemBody {
  code: string;
  detail: string;
  errors?: { field: string; code: string; title?: string; message: string }[];
}

describe.each(["oauth2", "session"] as const)("connect/%s — scope catalog", (surface) => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest(),
    });
    await registerClient(ctx, "catalogued");
    await registerClient(ctx, "open");
  });

  it("accepts scopes the auth's catalog declares, and asks consent for them", async () => {
    const res = await kickoff(ctx, surface, "catalogued", {
      scopes: ["gmail.readonly", "gmail.send"],
    });
    expect(res.status).toBe(200);
    // A 200 that dropped the scopes would send the user through a consent
    // screen that grants less than the caller asked for, and the very next
    // resolution would fail on insufficient_scopes.
    expect(await requestedScopes(surface, res)).toEqual(
      surface === "session"
        ? ["gmail.readonly", "gmail.send"]
        : ["openid", "gmail.readonly", "gmail.send"],
    );
  });

  it("rejects a scope the catalog does not declare, naming it", async () => {
    const res = await kickoff(ctx, surface, "catalogued", {
      scopes: ["gmail.readonly", "drive.file"],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    expect(body.code).toBe("validation_failed");
    expect(body.errors).toEqual([
      {
        field: "scopes",
        code: "scope_not_in_catalog",
        title: "Scope Not in Catalog",
        message: "Scopes not declared in scope_catalog of auth 'catalogued': drive.file",
      },
    ]);
    // The accepted scope is not part of the complaint.
    expect(body.detail).not.toContain("gmail.readonly");
  });

  it("accepts any scope on an auth that declares no catalog", async () => {
    // No catalog = no closed set: the IdP arbitrates at consent time. Same
    // contract `validateAgentIntegrationScopes` applies to an agent selection.
    const res = await kickoff(ctx, surface, "open", { scopes: ["anything.the.idp.knows"] });
    expect(res.status).toBe(200);
    expect(await requestedScopes(surface, res)).toEqual(
      surface === "session" ? ["anything.the.idp.knows"] : ["openid", "anything.the.idp.knows"],
    );
  });

  it("accepts a kickoff that requests no scopes at all", async () => {
    const res = await kickoff(ctx, surface, "catalogued", {});
    expect(res.status).toBe(200);
    // Nothing invented on the caller's behalf: the token carries no `scopes`
    // claim at all (omitted, never `[]`), and the redirect asks for the auth's
    // declared defaults and nothing more.
    expect(await requestedScopes(surface, res)).toEqual(
      surface === "session" ? undefined : ["openid"],
    );
  });
});
