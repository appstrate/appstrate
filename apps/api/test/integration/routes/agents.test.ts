// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import {
  seedAgent,
  seedRun,
  seedApplication,
  seedOrgModel,
  seedOrgModelProviderKey,
} from "../../helpers/seed.ts";
import {
  getSystemModels,
  initSystemModelProviderKeys,
} from "../../../src/services/model-registry.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { createVersionFromDraft } from "../../../src/services/package-versions.ts";
import { assertDbCount } from "../../helpers/assertions.ts";
import { packages, runs } from "@appstrate/db/schema";
import { addMemories, upsertPinned } from "../../../src/services/state/package-persistence.ts";

const app = getTestApp();

/** Seed an agent and install it in the default app. */
async function seedInstalledAgent(
  overrides: Parameters<typeof seedAgent>[0] & { applicationId: string },
) {
  const { applicationId, ...rest } = overrides;
  const pkg = await seedAgent(rest);
  await installPackage({ orgId: rest.orgId!, applicationId: applicationId }, pkg.id);
  return pkg;
}

describe("Agents API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
  });

  describe("GET /api/agents", () => {
    it("returns empty list when no agents exist", async () => {
      const res = await app.request("/api/agents", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toBeArray();
      expect(body.data).toHaveLength(0);
    });

    it("returns agents installed in the current app", async () => {
      await seedInstalledAgent({
        id: "@myorg/test-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        applicationId: ctx.defaultAppId,
      });

      const res = await app.request("/api/agents", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      const agent = body.data.find((f: { id: string }) => f.id === "@myorg/test-agent");
      expect(agent).toBeDefined();
      expect(agent.source).toBe("local");
    });

    it("returns scope WITH the @ sigil — directly usable as a {scope} path param (#629)", async () => {
      await seedInstalledAgent({
        id: "@myorg/scoped-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        applicationId: ctx.defaultAppId,
      });

      const res = await app.request("/api/agents", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const agent = body.data.find((f: { id: string }) => f.id === "@myorg/scoped-agent");
      expect(agent.scope).toBe("@myorg");

      // Round-trip: the listed scope must be accepted verbatim by the
      // {scope}/{name} detail route — one op's output is the next op's input.
      const detail = await app.request(`/api/packages/agents/${agent.scope}/scoped-agent`, {
        headers: authHeaders(ctx),
      });
      expect(detail.status).toBe(200);
      const detailBody = (await detail.json()) as any;
      expect(detailBody.scope).toBe("@myorg");
    });

    it("does not leak agents from other orgs", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedAgent({ id: "@otherorg/secret-agent", orgId: otherCtx.orgId });

      const res = await app.request("/api/agents", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const leaked = body.data.find((f: { id: string }) => f.id === "@otherorg/secret-agent");
      expect(leaked).toBeUndefined();
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/agents");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/packages/agents/:scope/:name (agent detail)", () => {
    it("returns agent detail when installed", async () => {
      await seedInstalledAgent({
        id: "@myorg/detail-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        applicationId: ctx.defaultAppId,
      });

      const res = await app.request("/api/packages/agents/@myorg/detail-agent", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body).toBeDefined();
      expect(body.id).toBe("@myorg/detail-agent");
    });

    it("returns 404 for non-existent agent", async () => {
      const res = await app.request("/api/packages/agents/@myorg/nonexistent", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 404 for agent from another org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg2" });
      await seedAgent({ id: "@otherorg2/private-agent", orgId: otherCtx.orgId });

      const res = await app.request("/api/packages/agents/@otherorg2/private-agent", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 404 from default app when agent is not installed (no bypass)", async () => {
      await seedAgent({ id: "@myorg/default-hidden", orgId: ctx.orgId, createdBy: ctx.user.id });

      // Agent is in the org catalog but NOT installed in the default app
      const res = await app.request("/api/packages/agents/@myorg/default-hidden", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 200 from default app when agent is installed", async () => {
      await seedInstalledAgent({
        id: "@myorg/default-installed",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        applicationId: ctx.defaultAppId,
      });

      const res = await app.request("/api/packages/agents/@myorg/default-installed", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe("@myorg/default-installed");
    });

    it("returns 404 from custom app when agent is not installed", async () => {
      await seedAgent({ id: "@myorg/custom-hidden", orgId: ctx.orgId, createdBy: ctx.user.id });

      const customApp = await seedApplication({
        orgId: ctx.orgId,
        name: "Custom App",
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/agents/@myorg/custom-hidden", {
        headers: { ...authHeaders(ctx), "X-Application-Id": customApp.id },
      });

      expect(res.status).toBe(404);
    });

    it("returns 200 from custom app when agent is installed", async () => {
      await seedAgent({ id: "@myorg/custom-installed", orgId: ctx.orgId, createdBy: ctx.user.id });

      const customApp = await seedApplication({
        orgId: ctx.orgId,
        name: "Custom Installed",
        createdBy: ctx.user.id,
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: customApp.id },
        "@myorg/custom-installed",
      );

      const res = await app.request("/api/packages/agents/@myorg/custom-installed", {
        headers: { ...authHeaders(ctx), "X-Application-Id": customApp.id },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe("@myorg/custom-installed");
    });

    // #770 — the detail projection must follow `?version=`, not always the
    // draft. Publish 1.0.0 from one manifest, then dirty the draft with a
    // different input / skills / integrations set. `?version=1.0.0` must return
    // the FROZEN definition (what the run executes); default + `?version=draft`
    // return the live draft — otherwise the run-options modal renders the wrong
    // config/input/skills for the selected version.
    it("?version projects input/skills/integrations from that published manifest", async () => {
      const VER = "@myorg/versioned-detail";
      const publishedManifest = {
        name: VER,
        version: "1.0.0",
        type: "agent",
        schema_version: "0.2",
        display_name: "Versioned Detail",
        input: { schema: { type: "object", properties: { alpha: { type: "string" } } } },
        dependencies: {
          skills: { "@myorg/skill-pub": "^1.0.0" },
          integrations: { "@myorg/int-pub": "^1.0.0" },
        },
      };

      // Seed draft = the to-be-published manifest, then freeze it as 1.0.0.
      await seedInstalledAgent({
        id: VER,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        applicationId: ctx.defaultAppId,
        draftManifest: publishedManifest,
      });
      const published = await createVersionFromDraft({
        packageId: VER,
        orgId: ctx.orgId,
        userId: ctx.user.id,
      });
      expect("version" in published && published.version).toBe("1.0.0");

      // Dirty the draft: different input field, skills, and integrations.
      await db
        .update(packages)
        .set({
          draftManifest: {
            ...publishedManifest,
            input: { schema: { type: "object", properties: { beta: { type: "string" } } } },
            dependencies: {
              skills: { "@myorg/skill-draft": "^2.0.0" },
              integrations: { "@myorg/int-draft": "^1.0.0" },
            },
          },
          updatedAt: new Date(Date.now() + 5_000),
        })
        .where(eq(packages.id, VER));

      const get = (suffix: string) =>
        app.request(`/api/packages/agents/${VER}${suffix}`, { headers: authHeaders(ctx) });

      // Default → draft projection. Input + integrations are manifest-derived
      // on the draft path; the draft's skills array lists only skills that
      // resolve against the org catalog (empty for these unseeded skill
      // packages), so the version-vs-draft contrast is asserted on input +
      // integrations.
      const draftBody = (await (await get("")).json()) as any;
      expect(draftBody.input.schema.properties).toHaveProperty("beta");
      expect(draftBody.dependencies.integrations.map((i: any) => i.id)).toEqual([
        "@myorg/int-draft",
      ]);

      // ?version=1.0.0 → frozen published projection. Skills here are read
      // straight from the version manifest's `dependencies.skills`.
      const verRes = await get("?version=1.0.0");
      expect(verRes.status).toBe(200);
      const verBody = (await verRes.json()) as any;
      expect(verBody.input.schema.properties).toHaveProperty("alpha");
      expect(verBody.dependencies.skills.map((s: any) => s.id)).toEqual(["@myorg/skill-pub"]);
      expect(verBody.dependencies.integrations.map((i: any) => i.id)).toEqual(["@myorg/int-pub"]);

      // ?version=draft ≡ default.
      const draftExplicit = (await (await get("?version=draft")).json()) as any;
      expect(draftExplicit.input.schema.properties).toHaveProperty("beta");
    });
  });

  describe("PUT /api/agents/:scope/:name/config", () => {
    it("updates agent configuration", async () => {
      await seedAgent({
        id: "@myorg/config-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@myorg/config-agent",
          version: "0.1.0",
          type: "agent",
          description: "Test",
          config: {
            schema: { type: "object", properties: { key: { type: "string" } } },
          },
        },
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@myorg/config-agent",
      );

      const res = await app.request("/api/agents/@myorg/config-agent/config", {
        method: "PUT",
        headers: {
          ...authHeaders(ctx),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ key: "value" }),
      });

      expect(res.status).toBe(200);
      // 200 + the bare persisted configuration document (#657) — no
      // `{config, validation}` envelope; validation failures are 400s.
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.key).toBe("value");
      expect("config" in body).toBe(false);
      expect("validation" in body).toBe(false);
    });
  });

  describe("GET /api/agents/:scope/:name/bundle — 404 distinction", () => {
    // The bundle route deliberately distinguishes "agent doesn't exist in
    // this org" from "agent exists in org but isn't installed in the
    // pinned application" — the CLI's run-by-id flow needs to tell the
    // user whether to fix the spelling or run an install. Pin both
    // branches so the contract holds across refactors.

    it("returns 404 agent_not_found when the package isn't in the org catalog", async () => {
      const res = await app.request("/api/agents/@myorg/does-not-exist/bundle", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code?: string; detail?: string };
      expect(body.code).toBe("agent_not_found");
    });

    it("returns 404 agent_not_installed_in_app when the package exists in org but is not installed in the pinned app", async () => {
      // Seed the agent at the org level, but DON'T install it into the app.
      await seedAgent({
        id: "@myorg/uninstalled-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/agents/@myorg/uninstalled-agent/bundle", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code?: string; detail?: string };
      expect(body.code).toBe("agent_not_installed_in_app");
      // The detail names the application and the install endpoint so the
      // CLI's hint can quote it back to the user verbatim.
      expect(body.detail).toContain(ctx.defaultAppId);
      expect(body.detail).toContain("/api/applications/");
    });

    it("passes the access gate when the package is installed (subsequent failures are version/artifact, not access)", async () => {
      // The 200/version-resolution path requires a published artifact in
      // storage that the seed helpers don't set up. The relevant contract
      // for *this* gate is that we don't surface `agent_not_installed_in_app`
      // for an installed package — version-resolution failures throw
      // `not_found`, a different code.
      await seedInstalledAgent({
        id: "@myorg/installed-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        applicationId: ctx.defaultAppId,
      });

      const res = await app.request("/api/agents/@myorg/installed-agent/bundle", {
        headers: authHeaders(ctx),
      });
      const body = (await res.json()) as { code?: string };
      expect(body.code).not.toBe("agent_not_installed_in_app");
      expect(body.code).not.toBe("agent_not_found");
    });
  });

  describe("GET /api/agents/:scope/:name/bundle?source=draft — UI parity path", () => {
    // Pin the dashboard-Run-button parity contract. A never-published
    // agent must bundle its draft state via `?source=draft`, otherwise
    // `appstrate run @scope/agent` fails with `no_published_version`
    // on agents the dashboard runs happily.

    it("returns 200 + a deterministic .afps-bundle for an installed never-published agent", async () => {
      await seedInstalledAgent({
        id: "@myorg/draft-only",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        applicationId: ctx.defaultAppId,
      });

      const res = await app.request("/api/agents/@myorg/draft-only/bundle?source=draft", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const integrity = res.headers.get("X-Bundle-Integrity");
      expect(integrity).toMatch(/^sha256-/);
      expect(res.headers.get("Content-Type")).toBe("application/zip");

      // X-Bundle-Integrity contract: SHA256 over the wire bytes, NOT the
      // in-archive `bundle.integrity` field (which is the canonical
      // packages-map JSON SRI). The CLI recomputes the wire digest after
      // download to detect proxy/CDN corruption — a regression that ever
      // sends `bundle.integrity` instead trips `integrity_mismatch` on
      // every clean run, which is the exact bug we just fixed.
      const body = new Uint8Array(await res.arrayBuffer());
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(body);
      const computed = `sha256-${hasher.digest("base64")}`;
      expect(integrity).toBe(computed);
    });

    it("rejects ?source=draft combined with ?version= (400 draft_with_version)", async () => {
      await seedInstalledAgent({
        id: "@myorg/draft-with-version",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        applicationId: ctx.defaultAppId,
      });

      const res = await app.request(
        "/api/agents/@myorg/draft-with-version/bundle?source=draft&version=1.0.0",
        { headers: authHeaders(ctx) },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("draft_with_version");
    });

    it("rejects ?source=foo (400 invalid_source)", async () => {
      const res = await app.request("/api/agents/@myorg/anything/bundle?source=experimental", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("invalid_source");
    });
  });

  describe("Multi-tenancy isolation", () => {
    it("isolates run counts per org", async () => {
      await seedInstalledAgent({
        id: "@myorg/counted-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        applicationId: ctx.defaultAppId,
      });
      await seedRun({
        packageId: "@myorg/counted-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });
      await seedRun({
        packageId: "@myorg/counted-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "running",
      });

      // Verify DB state directly
      await assertDbCount(
        runs,
        and(eq(runs.packageId, "@myorg/counted-agent"), eq(runs.orgId, ctx.orgId))!,
        2,
      );

      // Verify running count in agent list
      const res = await app.request("/api/agents", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const agent = body.data.find((f: { id: string }) => f.id === "@myorg/counted-agent");
      expect(agent).toBeDefined();
      expect(agent.running_runs).toBe(1);
    });
  });

  // ─── Persistence Routes (pinned slots + memories) ─

  describe("GET /api/agents/:scope/:name/persistence", () => {
    it("returns pinned slots as an array (admin sees every actor's row)", async () => {
      await seedInstalledAgent({
        id: "@myorg/persist-list",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        applicationId: ctx.defaultAppId,
      });

      // Two distinct scopes write pinned `checkpoint` slots
      await upsertPinned(
        "@myorg/persist-list",
        ctx.defaultAppId,
        ctx.orgId,
        { type: "user", id: ctx.user.id },
        "checkpoint",
        { step: "user-checkpoint" },
        null,
      );
      await upsertPinned(
        "@myorg/persist-list",
        ctx.defaultAppId,
        ctx.orgId,
        { type: "shared" },
        "checkpoint",
        { step: "shared-checkpoint" },
        null,
      );

      const res = await app.request("/api/agents/@myorg/persist-list/persistence?kind=pinned", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        pinned: Array<{ key: string; actor_type: string; content: { step: string } }>;
      };
      expect(Array.isArray(body.pinned)).toBe(true);
      expect(body.pinned).toHaveLength(2);
      const actorTypes = body.pinned.map((c) => c.actor_type).sort();
      expect(actorTypes).toEqual(["shared", "user"]);
      // Every row is the `checkpoint` slot here.
      expect(body.pinned.every((c) => c.key === "checkpoint")).toBe(true);
    });

    it("returns Letta-style named pinned slots alongside the checkpoint slot", async () => {
      await seedInstalledAgent({
        id: "@myorg/persist-named-pin",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        applicationId: ctx.defaultAppId,
      });

      // Mix of keys: `checkpoint` + Letta-style `persona` + `goals`
      await upsertPinned(
        "@myorg/persist-named-pin",
        ctx.defaultAppId,
        ctx.orgId,
        { type: "shared" },
        "checkpoint",
        { step: "carry-over" },
        null,
      );
      await upsertPinned(
        "@myorg/persist-named-pin",
        ctx.defaultAppId,
        ctx.orgId,
        { type: "shared" },
        "persona",
        "Senior coding assistant",
        null,
      );
      await upsertPinned(
        "@myorg/persist-named-pin",
        ctx.defaultAppId,
        ctx.orgId,
        { type: "shared" },
        "goals",
        ["ship faster", "fewer bugs"],
        null,
      );

      const res = await app.request(
        "/api/agents/@myorg/persist-named-pin/persistence?kind=pinned",
        { headers: authHeaders(ctx) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        pinned: Array<{ key: string; content: unknown }>;
      };
      const keys = body.pinned.map((p) => p.key).sort();
      expect(keys).toEqual(["checkpoint", "goals", "persona"]);
    });

    it("filters memories by runId", async () => {
      await seedInstalledAgent({
        id: "@myorg/persist-runid",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        applicationId: ctx.defaultAppId,
      });
      const r1 = await seedRun({
        packageId: "@myorg/persist-runid",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });
      const r2 = await seedRun({
        packageId: "@myorg/persist-runid",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });
      await addMemories(
        "@myorg/persist-runid",
        ctx.defaultAppId,
        ctx.orgId,
        { type: "user", id: ctx.user.id },
        ["from-r1-a", "from-r1-b"],
        r1.id,
      );
      await addMemories(
        "@myorg/persist-runid",
        ctx.defaultAppId,
        ctx.orgId,
        { type: "user", id: ctx.user.id },
        ["from-r2"],
        r2.id,
      );

      const res = await app.request(
        `/api/agents/@myorg/persist-runid/persistence?kind=memory&runId=${r1.id}`,
        { headers: authHeaders(ctx) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { memories: Array<{ runId: string }> };
      expect(body.memories).toHaveLength(2);
      expect(body.memories.every((m) => m.runId === r1.id)).toBe(true);
    });
  });

  describe("DELETE /api/agents/:scope/:name/persistence/pinned/:id", () => {
    it("deletes a single pinned slot by id", async () => {
      await seedInstalledAgent({
        id: "@myorg/persist-del-cp",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        applicationId: ctx.defaultAppId,
      });
      await upsertPinned(
        "@myorg/persist-del-cp",
        ctx.defaultAppId,
        ctx.orgId,
        { type: "shared" },
        "checkpoint",
        { step: "x" },
        null,
      );

      const listRes = await app.request(
        "/api/agents/@myorg/persist-del-cp/persistence?kind=pinned",
        { headers: authHeaders(ctx) },
      );
      const listBody = (await listRes.json()) as { pinned: Array<{ id: number }> };
      expect(listBody.pinned).toHaveLength(1);
      const slotId = listBody.pinned[0]!.id;

      const delRes = await app.request(
        `/api/agents/@myorg/persist-del-cp/persistence/pinned/${slotId}`,
        { method: "DELETE", headers: authHeaders(ctx) },
      );
      expect(delRes.status).toBe(204);

      const after = await app.request("/api/agents/@myorg/persist-del-cp/persistence?kind=pinned", {
        headers: authHeaders(ctx),
      });
      const afterBody = (await after.json()) as { pinned: unknown[] };
      expect(afterBody.pinned).toHaveLength(0);
    });

    it("deletes a Letta-style named pinned slot (e.g. persona) by id", async () => {
      await seedInstalledAgent({
        id: "@myorg/persist-del-persona",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        applicationId: ctx.defaultAppId,
      });
      await upsertPinned(
        "@myorg/persist-del-persona",
        ctx.defaultAppId,
        ctx.orgId,
        { type: "shared" },
        "persona",
        "Senior coding assistant",
        null,
      );

      const listRes = await app.request(
        "/api/agents/@myorg/persist-del-persona/persistence?kind=pinned",
        { headers: authHeaders(ctx) },
      );
      const listBody = (await listRes.json()) as { pinned: Array<{ id: number; key: string }> };
      const personaSlot = listBody.pinned.find((s) => s.key === "persona")!;

      const delRes = await app.request(
        `/api/agents/@myorg/persist-del-persona/persistence/pinned/${personaSlot.id}`,
        { method: "DELETE", headers: authHeaders(ctx) },
      );
      expect(delRes.status).toBe(204);
    });

    it("returns 404 for unknown pinned slot id", async () => {
      await seedInstalledAgent({
        id: "@myorg/persist-del-404",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        applicationId: ctx.defaultAppId,
      });

      const res = await app.request(
        "/api/agents/@myorg/persist-del-404/persistence/pinned/999999",
        { method: "DELETE", headers: authHeaders(ctx) },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/agents/:scope/:name/proxy", () => {
    it("returns the bare proxy-setting resource (same shape as GET)", async () => {
      await seedInstalledAgent({
        id: "@myorg/proxy-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        applicationId: ctx.defaultAppId,
      });

      const res = await app.request("/api/agents/@myorg/proxy-agent/proxy", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ proxyId: "none" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        proxyId: string | null;
        resolved: boolean;
      } & Record<string, unknown>;
      // Bare proxy-setting resource — no `success` scrap (#657).
      expect(body.proxyId).toBe("none");
      expect(body.resolved).toBe(false);
      expect("success" in body).toBe(false);

      // The returned shape matches what GET …/proxy serves.
      const get = await app.request("/api/agents/@myorg/proxy-agent/proxy", {
        headers: authHeaders(ctx),
      });
      const getBody = (await get.json()) as { proxyId: string | null; resolved: boolean };
      expect(getBody.proxyId).toBe(body.proxyId);
      expect(getBody.resolved).toBe(body.resolved);
    });
  });

  describe("PUT /api/agents/:scope/:name/model", () => {
    const SYSTEM_PRESET = "system-agent-model-test";

    beforeAll(() => {
      initSystemModelProviderKeys([
        {
          id: "system-agent-model-key",
          providerId: "test-apikey",
          baseUrlOverride: "https://api.openai.test/v1",
          apiKey: "sk-system-test",
          models: [{ id: SYSTEM_PRESET, modelId: "upstream-system-model" }],
        },
      ]);
      expect(getSystemModels().has(SYSTEM_PRESET)).toBe(true);
    });

    afterAll(() => {
      // Restore the env-derived (empty) baseline for the rest of the run.
      initSystemModelProviderKeys();
    });

    async function seedModelAgent() {
      await seedInstalledAgent({
        id: "@myorg/model-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        applicationId: ctx.defaultAppId,
      });
    }

    function putModel(modelId: string | null, headers = authHeaders(ctx)) {
      return app.request("/api/agents/@myorg/model-agent/model", {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
    }

    it("returns the bare model-setting resource (same shape as GET)", async () => {
      await seedModelAgent();
      const key = await seedOrgModelProviderKey({ orgId: ctx.orgId });
      const model = await seedOrgModel({ orgId: ctx.orgId, credentialId: key.id });

      const res = await putModel(model.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { modelId: string | null } & Record<string, unknown>;
      // Bare model-setting resource — no `success` scrap (#657).
      expect(body.modelId).toBe(model.id);
      expect("success" in body).toBe(false);

      // Reverting to org default returns the null resource, not a stub.
      const revert = await putModel(null);
      expect(revert.status).toBe(200);
      const revertBody = (await revert.json()) as { modelId: string | null };
      expect(revertBody.modelId).toBeNull();
    });

    it("accepts a system model preset id", async () => {
      await seedModelAgent();

      const res = await putModel(SYSTEM_PRESET);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { modelId: string | null };
      expect(body.modelId).toBe(SYSTEM_PRESET);
    });

    it("rejects an unknown model id with 404 and does not persist it (#960)", async () => {
      await seedModelAgent();

      const res = await putModel("raw-upstream-model-name");
      expect(res.status).toBe(404);

      const get = await app.request("/api/agents/@myorg/model-agent/model", {
        headers: authHeaders(ctx),
      });
      const body = (await get.json()) as { modelId: string | null };
      expect(body.modelId).toBeNull();
    });

    it("rejects a model UUID owned by another org (#960)", async () => {
      await seedModelAgent();
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      const otherKey = await seedOrgModelProviderKey({ orgId: otherCtx.orgId });
      const otherModel = await seedOrgModel({
        orgId: otherCtx.orgId,
        credentialId: otherKey.id,
      });

      const res = await putModel(otherModel.id);
      expect(res.status).toBe(404);

      const get = await app.request("/api/agents/@myorg/model-agent/model", {
        headers: authHeaders(ctx),
      });
      const body = (await get.json()) as { modelId: string | null };
      expect(body.modelId).toBeNull();
    });
  });
});
