// SPDX-License-Identifier: Apache-2.0

/**
 * An auth that injects a credential over HTTP must bound its hosts (#1641): every path that
 * writes an integration manifest refuses `allow_all_uris` or a host-unbounded `authorized_uris`
 * entry on it (`CONFIG_BY_TYPE.checkManifest`), and accepts an auth the proxy injects nothing for.
 * The same gate refuses an expression the platform does not evaluate, and a `default_tools`
 * entry the platform can prove the integration does not expose (`findUnexposedDefaultTools`).
 */

import { etagVersion, ifMatch } from "../../helpers/etag.ts";
import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { packages, packageVersions } from "@appstrate/db/schema";
import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { asRecord } from "@appstrate/core/safe-json";
import {
  apiIntegrationManifest,
  envDelivery,
  localIntegrationManifest,
  mcpServerManifest,
  remoteIntegrationManifest,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();

const ID = "@alloworg/api";

function manifest(auth: {
  type: "api_key" | "custom";
  authorizedUris?: string[];
  allowAll?: true;
}) {
  return apiIntegrationManifest({
    name: ID,
    auths: {
      api: {
        type: auth.type,
        ...(auth.authorizedUris ? { authorizedUris: auth.authorizedUris } : {}),
        ...(auth.allowAll ? { allowAllUris: true } : {}),
        ...(auth.type === "custom" ? { delivery: envDelivery({ TOKEN: "api_key" }) } : {}),
      },
    },
  }) as unknown as Record<string, unknown>;
}

interface ProblemBody {
  errors?: { field?: string; code?: string }[];
}

async function expectRefused(res: Response, field: string) {
  expect(res.status).toBe(400);
  const body = (await res.json()) as ProblemBody;
  expect(body.errors?.[0]).toMatchObject({ field, code: "invalid_manifest" });
}

let ctx: TestContext;

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "alloworg" });
});

function create(m: Record<string, unknown>) {
  return app.request("/api/packages/integrations", {
    method: "POST",
    headers: authHeaders(ctx, { "Content-Type": "application/json" }),
    body: JSON.stringify({ manifest: m }),
  });
}

describe("writing an injecting auth's allowlist", () => {
  it("create refuses allow_all_uris and writes nothing", async () => {
    await expectRefused(
      await create(manifest({ type: "api_key", allowAll: true })),
      "manifest.auths.api.allow_all_uris",
    );
    expect(await db.select({ id: packages.id }).from(packages)).toEqual([]);
  });

  it("create refuses an expression the platform does not evaluate", async () => {
    const m = manifest({ type: "api_key" }) as { auths: { api: { delivery: unknown } } };
    m.auths.api.delivery = { http: { in: "header", name: "X-Key", value: "{$outputs.api_key}" } };
    await expectRefused(await create(m), "manifest.auths.api.delivery.http.value");
  });

  it("create refuses a plain http:// entry, and accepts it for a host the operator designated", async () => {
    const cleartext = manifest({
      type: "api_key",
      authorizedUris: ["https://api.example.com/**", "http://vault.internal/**"],
    });
    await expectRefused(await create(cleartext), "manifest.auths.api.authorized_uris.1");
    expect(await db.select({ id: packages.id }).from(packages)).toEqual([]);

    const previous = process.env.EGRESS_ALLOW_INTERNAL_HOSTS;
    process.env.EGRESS_ALLOW_INTERNAL_HOSTS = "vault.internal";
    resetEnvCache();
    try {
      expect((await create(cleartext)).status).toBe(201);
    } finally {
      if (previous === undefined) delete process.env.EGRESS_ALLOW_INTERNAL_HOSTS;
      else process.env.EGRESS_ALLOW_INTERNAL_HOSTS = previous;
      resetEnvCache();
    }
  });

  it("create accepts allow_all_uris on an auth the proxy injects nothing for", async () => {
    expect((await create(manifest({ type: "custom", allowAll: true }))).status).toBe(201);
  });

  it("draft save refuses a host-unbounded entry and leaves the draft untouched", async () => {
    const created = await create(manifest({ type: "api_key" }));
    expect(created.status).toBe(201);
    const res = await app.request(`/api/packages/integrations/${ID}`, {
      method: "PATCH",
      headers: authHeaders(ctx, {
        "Content-Type": "application/json",
        ...ifMatch(etagVersion(created)),
      }),
      body: JSON.stringify({
        manifest: manifest({ type: "api_key", authorizedUris: ["https://**"] }),
      }),
    });
    await expectRefused(res, "manifest.auths.api.authorized_uris.0");
    const [row] = await db
      .select({ draftManifest: packages.draftManifest })
      .from(packages)
      .where(eq(packages.id, ID));
    expect(row?.draftManifest).toMatchObject({
      auths: { api: { authorized_uris: ["https://api.example.com/**"] } },
    });
  });
});

describe("a default_tools entry the integration provably does not expose", () => {
  const auths = { api: { type: "api_key" as const } };
  const SERVER_ID = `${ID}-server`;

  async function expectNothingWritten() {
    expect(await db.select({ id: packages.id }).from(packages).where(eq(packages.id, ID))).toEqual(
      [],
    );
  }

  it("refuses a remote default naming a hidden tool, writing nothing", async () => {
    const hidden = {
      ...remoteIntegrationManifest({ name: ID, auths }),
      hidden_tools: ["send"],
      default_tools: ["search", "send"],
    };
    await expectRefused(await create(hidden), "manifest.default_tools");
    await expectNothingWritten();
  });

  it("refuses a remote default naming a tool its tools_policy does not list", async () => {
    const policed = (defaultTools: string[]) => ({
      ...remoteIntegrationManifest({ name: ID, auths, tools_policy: { search: {} } }),
      default_tools: defaultTools,
    });
    const res = await create(policed(["search", "serach"]));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors?: Record<string, unknown>[] };
    expect(body.errors).toEqual([
      expect.objectContaining({
        field: "manifest.default_tools",
        code: "invalid_manifest",
        message: 'default_tools contains "serach" which is not a tool this integration exposes',
      }),
    ]);
    await expectNothingWritten();
    expect((await create(policed(["search"]))).status).toBe(201);
  });

  it("accepts any remote default name when the integration declares no tools_policy", async () => {
    const res = await create({
      ...remoteIntegrationManifest({ name: ID, auths }),
      default_tools: ["anything"],
    });
    expect(res.status).toBe(201);
  });

  it("judges a local default against the mcp-server a run spawns: create, import, publish", async () => {
    const server = (version: string, tools: string[]) => ({
      ...mcpServerManifest({ name: SERVER_ID, version }),
      tools: tools.map((name) => ({ name })),
    });
    await seedPackage({
      id: SERVER_ID,
      orgId: ctx.orgId,
      type: "mcp-server",
      source: "local",
      // The draft a run never reads: only the published 1.0.0 declares `send`.
      draftManifest: server("1.1.0", ["search", "draft_only"]),
    });
    await seedPackageVersion({
      packageId: SERVER_ID,
      version: "1.0.0",
      manifest: server("1.0.0", ["search", "send"]),
    });
    const local = (defaultTools: string[]) => ({
      ...localIntegrationManifest({ name: ID, auths }),
      default_tools: defaultTools,
    });

    const unexposed = local(["search", "draft_only"]);
    await expectRefused(await create(unexposed), "manifest.default_tools");
    const form = new FormData();
    const zip = zipSync({ "manifest.json": new TextEncoder().encode(JSON.stringify(unexposed)) });
    form.append("file", new File([new Uint8Array(zip)], "local.afps"));
    await expectRefused(
      await app.request("/api/packages/import", {
        method: "POST",
        headers: authHeaders(ctx),
        body: form,
      }),
      "manifest.default_tools",
    );
    await expectNothingWritten();

    expect((await create(local(["search", "send"]))).status).toBe(201);
    // The spawn now resolves `^1.0.0` to a version that dropped `send`: the draft cannot freeze.
    await seedPackageVersion({
      packageId: SERVER_ID,
      version: "1.0.1",
      manifest: server("1.0.1", ["search"]),
    });
    await expectRefused(
      await app.request(`/api/packages/integrations/${ID}/versions`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ version: "1.0.1" }),
      }),
      "manifest.default_tools",
    );
  });

  it("leaves a local default unjudged while its mcp-server does not resolve", async () => {
    const res = await create({
      ...localIntegrationManifest({ name: ID, auths }),
      default_tools: ["anything"],
    });
    expect(res.status).toBe(201);
  });

  it("accepts a none default another vendor's root _meta key may supply, and reads it back", async () => {
    const api = apiIntegrationManifest({
      name: ID,
      auths,
      apiCall: { authKey: "api" },
      defaultTools: ["api_call", "vendor_tool"],
    }) as unknown as Record<string, unknown>;
    await expectRefused(await create(api), "manifest.default_tools");
    const foreign = { ...api, _meta: { ...asRecord(api._meta), "com.example/tools": {} } };
    expect((await create(foreign)).status).toBe(201);

    const res = await app.request(`/api/integrations/${ID}`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { manifest: { default_tools: string[] } };
    expect(body.manifest.default_tools).toEqual(["api_call", "vendor_tool"]);
  });

  it("still reads a published version carrying a default the write paths refuse", async () => {
    const exposed = {
      ...remoteIntegrationManifest({ name: ID, auths }),
      default_tools: ["search"],
    };
    expect((await create(exposed)).status).toBe(201);
    const stored = { ...exposed, hidden_tools: ["search"] };
    await expectRefused(await create({ ...stored, name: `${ID}-two` }), "manifest.default_tools");
    await db
      .update(packageVersions)
      .set({ manifest: stored })
      .where(eq(packageVersions.packageId, ID));

    const res = await app.request(`/api/integrations/${ID}`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { manifest: { hidden_tools: string[] } };
    expect(body.manifest.hidden_tools).toEqual(["search"]);
  });
});
