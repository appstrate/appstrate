// SPDX-License-Identifier: Apache-2.0

/**
 * A credential's scope ceiling is closed under the core implications where the
 * pipeline writes it, so every reader of `scopeCeiling` — here a
 * `requireCeiling` guard — sees `runs:read` in a ceiling naming `runs:read-all`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import type { AppstrateModule, AuthStrategy } from "@appstrate/core/module";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedApiKey } from "../../helpers/seed.ts";
import { requireCeiling } from "../../../src/middleware/require-permission.ts";
import type { AppEnv } from "../../../src/types/index.ts";

const PROBE_PATH = "/api/scope-ceiling-probe";

let ctx: TestContext;

/** An inline delegate whose ceiling is the comma-separated `X-Test-Ceiling` header. */
const ceilingStrategy: AuthStrategy = {
  id: "scope-ceiling-probe",
  async authenticate({ headers }) {
    const ceiling = headers.get("x-test-ceiling");
    if (ceiling === null) return null;
    return {
      user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name },
      orgId: ctx.orgId,
      orgRole: "owner",
      authMethod: "test-scope-ceiling",
      principalKind: "delegate",
      permissions: ceiling.split(","),
    };
  },
};

const probeModule: AppstrateModule = {
  manifest: { id: "scope-ceiling-probe", name: "Scope Ceiling Probe", version: "1.0.0" },
  async init() {},
  authStrategies() {
    return [ceilingStrategy];
  },
  createRouter() {
    return new Hono<AppEnv>().get(PROBE_PATH, requireCeiling("runs", "read"), (c) => c.text("ok"));
  },
};

const app = getTestApp({ modules: [probeModule] });

async function keyHeaders(scopes: string[]): Promise<Record<string, string>> {
  const key = await seedApiKey({
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    createdBy: ctx.user.id,
    scopes,
  });
  return { Authorization: `Bearer ${key.rawKey}` };
}

describe("scope ceiling closed under the core implications", () => {
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "ceiling-implied" });
  });

  it("lets an API key scoped `runs:read-all` through a `runs:read` ceiling guard", async () => {
    const res = await app.request(PROBE_PATH, { headers: await keyHeaders(["runs:read-all"]) });
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it("lets a strategy ceiling naming `runs:read-all` through it too", async () => {
    const res = await app.request(PROBE_PATH, { headers: { "X-Test-Ceiling": "runs:read-all" } });
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it("still refuses a ceiling that implies nothing the guard asks for", async () => {
    const keyed = await app.request(PROBE_PATH, { headers: await keyHeaders(["agents:read"]) });
    expect(keyed.status).toBe(403);
    const viaStrategy = { "X-Test-Ceiling": "agents:read" };
    expect((await app.request(PROBE_PATH, { headers: viaStrategy })).status).toBe(403);
  });
});
