// SPDX-License-Identifier: Apache-2.0

/**
 * READING an agent is not RUNNING it — the whole table, on a placed-but-
 * switched-off agent.
 *
 * Two middlewares, two questions (`middleware/guards.ts`):
 *
 *   - `requireAgent()` asks PLACEMENT — homed here, offered here, or shipped
 *     with the deployment. It is mounted by every agent route and it answers
 *     one refusal, `404 agent_not_found`, to a caller whose space holds no
 *     placement at all: that space learns nothing about the agent, which is
 *     why the status is 404 on both branches and never 403;
 *   - `requireActiveAgent()` asks ACTIVATION, and only the three doors that
 *     make an agent run mount it: `POST …/run` (a rerun is the same route),
 *     `POST …/schedules` and `GET …/bundle`. It answers
 *     `404 agent_not_active_in_space` and names the call that repairs the
 *     state — the caller can already see this agent, so the switch is not a
 *     disclosure, and an opaque "not found" would send them hunting for a typo.
 *
 * Everything else — the reads, the three `configure` writes, the persistence
 * housekeeping, the space-package door — answers as if the switch did not
 * exist, because for those acts it does not. The detail page is the one that
 * CARRIES the switch: 404ing it would break the page that repairs the state.
 *
 * Readiness is the deliberate third case: it is a READ that reports what
 * blocks a run, so inactivity appears in its payload (`agent_not_active`,
 * `blocks_run: true`) next to `integration_not_active`, and the call answers
 * 200.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedSpacePackage, seedUnreachableSpace } from "../../helpers/seed.ts";
import { isActiveAgentGate, isAgentLookup } from "../../../src/middleware/guards.ts";

const app = getTestApp();

/** Homed in the space under test, then switched OFF there. */
const OFF = "@doors/switched-off";
/** In the organization, placed nowhere the caller reads. */
const UNPLACED = "@doors/unplaced";

let ctx: TestContext;

function headers() {
  return authHeaders(ctx);
}

/** The three doors that make the agent RUN. */
function executionDoors(packageId: string) {
  const h = headers();
  const json = { ...h, "Content-Type": "application/json" };
  return {
    run: () =>
      app.request(`/api/agents/${packageId}/run`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ version: "draft" }),
      }),
    rerun: () =>
      app.request(`/api/agents/${packageId}/run`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ rerun_from: "run_00000000-0000-4000-8000-000000000000" }),
      }),
    schedule: () =>
      app.request(`/api/agents/${packageId}/schedules`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          name: "Nightly",
          cron_expression: "0 3 * * *",
          version_override: "draft",
        }),
      }),
    bundle: () => app.request(`/api/agents/${packageId}/bundle?source=draft`, { headers: h }),
  };
}

/**
 * Every OTHER route that mounts `requireAgent()`, plus the two space-package
 * doors that answer the same question about the same agent. The expected
 * status is the one the act deserves — never the activation 404.
 */
function readAndConfigureDoors(packageId: string): Record<string, () => Promise<Response>> {
  const req = (path: string, init?: RequestInit) => Promise.resolve(app.request(path, init));
  const h = headers();
  const json = { ...h, "Content-Type": "application/json" };
  return {
    getModel: () => req(`/api/agents/${packageId}/model`, { headers: h }),
    getProxy: () => req(`/api/agents/${packageId}/proxy`, { headers: h }),
    getPersistence: () => req(`/api/agents/${packageId}/persistence`, { headers: h }),
    getRuns: () => req(`/api/agents/${packageId}/runs`, { headers: h }),
    getSchedules: () => req(`/api/agents/${packageId}/schedules`, { headers: h }),
    getDetail: () => req(`/api/packages/agents/${packageId}`, { headers: h }),
    patchModel: () =>
      req(`/api/agents/${packageId}/model`, {
        method: "PATCH",
        headers: json,
        body: JSON.stringify({ modelId: null }),
      }),
    putProxy: () =>
      req(`/api/agents/${packageId}/proxy`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ proxyId: "none" }),
      }),
    putInputSettings: () =>
      req(`/api/agents/${packageId}/input-settings`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ values: {}, locked_fields: [] }),
      }),
    putSpacePackage: () =>
      req(`/api/spaces/${ctx.defaultSpaceId}/packages/${packageId}`, {
        method: "PATCH",
        headers: json,
        body: JSON.stringify({ proxyId: "none" }),
      }),
    deleteRuns: () => req(`/api/agents/${packageId}/runs`, { method: "DELETE", headers: h }),
    deletePersistence: () =>
      req(`/api/agents/${packageId}/persistence`, { method: "DELETE", headers: h }),
  };
}

async function codeOf(res: Response): Promise<{ status: number; code?: string }> {
  const body = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { code?: string };
  return { status: res.status, code: body.code };
}

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext();
  await seedAgent({ id: OFF, orgId: ctx.orgId, homeSpaceId: ctx.defaultSpaceId });
  await seedSpacePackage(ctx.defaultSpaceId, OFF, { enabled: false });
  // Homed in a space nobody here reaches and offered nowhere: the placement
  // rule closes it, so this space is told nothing at all.
  await seedAgent({
    id: UNPLACED,
    orgId: ctx.orgId,
    homeSpaceId: await seedUnreachableSpace(ctx.orgId),
  });
});

describe("a placed-but-switched-off agent", () => {
  it("is refused on the three execution doors, and only there", async () => {
    for (const [name, call] of Object.entries(executionDoors(OFF))) {
      const got = await codeOf(await call());
      expect({ name, ...got }).toEqual({
        name,
        status: 404,
        code: "agent_not_active_in_space",
      });
    }
  });

  it("keeps `/api/runs/remote` on its own generic package vocabulary", async () => {
    // Not an agent route param: `/api/runs/remote` takes a package id of any
    // type, so it carries one code for the whole family and says the same
    // thing in the same words.
    const res = await app.request("/api/runs/remote", {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        source: { kind: "registry", packageId: OFF, stage: "draft" },
        spaceId: ctx.defaultSpaceId,
        input: {},
      }),
    });
    expect(await codeOf(res)).toEqual({ status: 404, code: "package_not_active_in_space" });
  });

  it("names the space and the door that fixes it", async () => {
    const res = await executionDoors(OFF).run();
    const body = (await res.json()) as { detail?: string };
    expect(body.detail).toContain(ctx.defaultSpaceId);
    expect(body.detail).toContain(`POST /api/spaces/${ctx.defaultSpaceId}/packages`);
  });

  it("answers every READ and every CONFIGURE as if the switch did not exist", async () => {
    // The table, whole. A refusal anywhere here is the page that carries the
    // switch refusing to load — `unified-package-detail.tsx` reads the model
    // and the readiness on mount, and `api/client.ts` throws on any non-2xx.
    const statuses: Record<string, number> = {};
    for (const [name, call] of Object.entries(readAndConfigureDoors(OFF))) {
      const res = await call();
      statuses[name] = res.status;
      if (res.status >= 400) {
        // Name the body, so a regression says WHY rather than just "not 200".
        expect({ name, body: await res.clone().text() }).toEqual({ name, body: "<2xx expected>" });
      }
    }
    expect(statuses).toEqual({
      getModel: 200,
      getProxy: 200,
      getPersistence: 200,
      getRuns: 200,
      getSchedules: 200,
      getDetail: 200,
      patchModel: 200,
      putProxy: 200,
      putInputSettings: 200,
      putSpacePackage: 200,
      deleteRuns: 200,
      deletePersistence: 200,
    });
  });

  it("reports the switch on its detail, and drops the agent from the index", async () => {
    // The detail is the page that CARRIES the switch, so it answers 200 and
    // says `active: false` — 404ing it would break the page that repairs the
    // state. The index answers the other question, "what can I launch here?",
    // so a switched-off agent is simply not on it: there is no greyed-out row
    // to explain, and the library is where the state and its switch live.
    const detail = await app.request(`/api/packages/agents/${OFF}`, { headers: headers() });
    expect(detail.status, await detail.clone().text()).toBe(200);
    expect(((await detail.json()) as { active: boolean }).active).toBe(false);

    const indexIds = async () => {
      const index = await app.request("/api/agents", { headers: headers() });
      expect(index.status, await index.clone().text()).toBe(200);
      return ((await index.json()) as { data: { id: string }[] }).data.map((row) => row.id);
    };
    expect(await indexIds()).not.toContain(OFF);

    // Positive control: the same agent, same fixture, switched back on.
    await seedSpacePackage(ctx.defaultSpaceId, OFF, { enabled: true });
    expect(await indexIds()).toContain(OFF);
  });

  it("reports the switch as a BLOCKING readiness error, with a 200", async () => {
    // Readiness is what the detail page renders to explain a refusal. A 404
    // here would blank the explanation and leave the user with a dead button
    // and no cause.
    const res = await app.request(`/api/agents/${OFF}/connection-readiness?version=draft`, {
      headers: headers(),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      blocks_run: boolean;
      errors: { field: string; code: string; message: string }[];
    };
    expect(body.blocks_run).toBe(true);
    expect(body.errors[0]?.code).toBe("agent_not_active");
    expect(body.errors[0]?.field).toBe("agent");
    expect(body.errors[0]?.message).toContain(OFF);
  });

  it("drops the readiness error the moment the agent is switched back on", async () => {
    // The CONTROL for the case above: same agent, same call, one activation
    // apart. Without it the assertion would pass against a payload that always
    // carried the error.
    const activate = await app.request(`/api/spaces/${ctx.defaultSpaceId}/packages`, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ packageId: OFF }),
    });
    expect(activate.status, await activate.clone().text()).toBe(201);

    const res = await app.request(`/api/agents/${OFF}/connection-readiness?version=draft`, {
      headers: headers(),
    });
    const body = (await res.json()) as { blocks_run: boolean; errors: { code: string }[] };
    expect(body.errors.map((e) => e.code)).not.toContain("agent_not_active");
    expect(body.blocks_run).toBe(false);

    // And the execution doors open again.
    for (const [name, call] of Object.entries(executionDoors(OFF))) {
      const got = await codeOf(await call());
      expect({ name, activationRefused: got.code === "agent_not_active_in_space" }).toEqual({
        name,
        activationRefused: false,
      });
    }
  });
});

describe("an agent this space holds no placement for", () => {
  it("keeps the OPAQUE code on every execution door", async () => {
    for (const [name, call] of Object.entries(executionDoors(UNPLACED))) {
      const got = await codeOf(await call());
      expect({ name, ...got }).toEqual({ name, status: 404, code: "agent_not_found" });
    }
  });

  it("keeps the OPAQUE code on the reads too — placement is what they ask", async () => {
    for (const [name, call] of Object.entries(readAndConfigureDoors(UNPLACED))) {
      const got = await codeOf(await call());
      // The package routes answer through their own gates — the space-package
      // door via `assertCatalogPackageAccess`, the detail via
      // `getPackageForRead` — with the vocabulary of a package rather than of
      // an agent. Same status, same opacity.
      const expected =
        name === "putSpacePackage" || name === "getDetail" ? "not_found" : "agent_not_found";
      expect({ name, status: got.status, code: got.code }).toEqual({
        name,
        status: 404,
        code: expected,
      });
    }
  });

  it("says nothing about where the agent lives", async () => {
    const res = await executionDoors(UNPLACED).run();
    const body = (await res.json()) as { detail?: string };
    expect(body.detail).not.toContain("/api/spaces/");
    expect(body.detail).not.toContain(ctx.defaultSpaceId);
  });
});

describe("the activation gate is mounted where the contract says, and nowhere else", () => {
  /**
   * `"METHOD /path" -> handlers in mount order`, from Hono's real route table.
   * The param CONSTRAINTS (`:scope{…}`) are stripped: they are a validation
   * detail of the scoped-package pattern, and leaving them in would make this
   * assertion fail on a tightening of the id regex that has nothing to do with
   * which routes gate execution.
   */
  function routeChains(): Map<string, unknown[]> {
    const chains = new Map<string, unknown[]>();
    for (const route of app.routes) {
      const key = `${route.method} ${route.path.replace(/\{.*?\}(?=\/|$)/g, "")}`;
      const chain = chains.get(key);
      if (chain) chain.push(route.handler);
      else chains.set(key, [route.handler]);
    }
    return chains;
  }

  it("mounts `requireActiveAgent()` on exactly the three execution doors", async () => {
    // A LIST, not a count: the routes that ask the execution question are the
    // contract of R30, and copying a neighbouring route is exactly how a read
    // acquires an execution gate it was never meant to have.
    const gated: string[] = [];
    for (const [key, chain] of routeChains()) {
      if (chain.some(isActiveAgentGate)) gated.push(key);
    }
    expect(gated.sort()).toEqual([
      "GET /api/agents/:scope/:name/bundle",
      "POST /api/agents/:scope/:name/run",
      "POST /api/agents/:scope/:name/schedules",
    ]);
  });

  it("never mounts it without the lookup that loads the agent in front of it", async () => {
    // `requireActiveAgent()` reads `c.get("package")`; mounted alone it would
    // throw on a context nothing filled.
    const offenders: string[] = [];
    for (const [key, chain] of routeChains()) {
      const gateAt = chain.findIndex(isActiveAgentGate);
      if (gateAt === -1) continue;
      const lookupAt = chain.findIndex(isAgentLookup);
      if (lookupAt === -1 || lookupAt > gateAt) offenders.push(key);
    }
    expect(offenders).toEqual([]);
  });
});
