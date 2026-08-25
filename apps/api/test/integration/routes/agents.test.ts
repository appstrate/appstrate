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
  seedOrgModelProviderOAuth,
} from "../../helpers/seed.ts";
import {
  getSystemModels,
  initSystemModelProviderKeys,
} from "../../../src/services/model-registry.ts";
import {
  getInstalledPackageSettings,
  installPackage,
  updateInstalledPackage,
} from "../../../src/services/application-packages.ts";
import { createVersionFromDraft } from "../../../src/services/package-versions.ts";
import { assertDbCount } from "../../helpers/assertions.ts";
import { packages, runs, schedules } from "@appstrate/db/schema";
import { addMemories, upsertPinned } from "../../../src/services/state/package-persistence.ts";
import { resolveEffectiveInput } from "../../../src/services/input-resolution.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";

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

  describe("PUT /api/agents/:scope/:name/input-settings", () => {
    it("stores input values and field locks", async () => {
      await seedAgent({
        id: "@myorg/input-settings-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@myorg/input-settings-agent",
          version: "0.1.0",
          type: "agent",
          description: "Test",
          input: {
            schema: { type: "object", properties: { key: { type: "string" } } },
          },
        },
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@myorg/input-settings-agent",
      );

      const res = await app.request("/api/agents/@myorg/input-settings-agent/input-settings", {
        method: "PUT",
        headers: {
          ...authHeaders(ctx),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ values: { key: "value" }, locked_fields: ["key"] }),
      });

      expect(res.status).toBe(200);
      // 200 + the bare persisted resource (#657) — no `validation` envelope;
      // validation failures are 400s.
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.values).toEqual({ key: "value" });
      expect(body.locked_fields).toEqual(["key"]);
      expect("validation" in body).toBe(false);
    });

    it("rejects a body missing locked_fields with 400 and leaves the stored row intact", async () => {
      await seedAgent({
        id: "@myorg/partial-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@myorg/partial-agent",
          version: "0.1.0",
          type: "agent",
          description: "Test",
          input: {
            schema: { type: "object", properties: { folder: { type: "string" } } },
          },
        },
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@myorg/partial-agent",
      );
      await updateInstalledPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@myorg/partial-agent",
        {
          inputSettings: { values: { folder: "archive" }, locked: ["folder"] },
        },
      );

      const res = await app.request("/api/agents/@myorg/partial-agent/input-settings", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ values: { folder: "sent" } }),
      });

      expect(res.status).toBe(400);
      const stored = await getInstalledPackageSettings(ctx.defaultAppId, "@myorg/partial-agent");
      expect(stored.values).toEqual({ folder: "archive" });
      expect(stored.locked).toEqual(["folder"]);
    });

    it("rejects a body carrying an unknown key with 400 and leaves the stored row intact", async () => {
      await seedAgent({
        id: "@myorg/unknown-key-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@myorg/unknown-key-agent",
          version: "0.1.0",
          type: "agent",
          description: "Test",
          input: {
            schema: { type: "object", properties: { folder: { type: "string" } } },
          },
        },
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@myorg/unknown-key-agent",
      );
      await updateInstalledPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@myorg/unknown-key-agent",
        { inputSettings: { values: { folder: "archive" }, locked: ["folder"] } },
      );

      // The pre-refactor body shape: bare field names at the top level.
      const res = await app.request("/api/agents/@myorg/unknown-key-agent/input-settings", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ values: {}, locked_fields: [], folder: "sent" }),
      });

      expect(res.status).toBe(400);
      const stored = await getInstalledPackageSettings(
        ctx.defaultAppId,
        "@myorg/unknown-key-agent",
      );
      expect(stored.values).toEqual({ folder: "archive" });
      expect(stored.locked).toEqual(["folder"]);
    });

    it("rejects a wrong-typed stored value with 400", async () => {
      await seedAgent({
        id: "@myorg/typed-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@myorg/typed-agent",
          version: "0.1.0",
          type: "agent",
          description: "Test",
          input: {
            schema: { type: "object", properties: { count: { type: "integer" } } },
          },
        },
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@myorg/typed-agent",
      );

      const res = await app.request("/api/agents/@myorg/typed-agent/input-settings", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ values: { count: "not-a-number" }, locked_fields: [] }),
      });

      expect(res.status).toBe(400);
    });

    // ── Pruning undeclared keys (regression of `mergeWithDefaults`) ────────
    //
    // `values` is round-tripped by key, but every form only RENDERS the
    // properties `input.schema` declares. An orphan key — a property a later
    // manifest edit dropped — is therefore invisible in the UI, un-removable
    // (the settings form re-submits it), and seeded as caller input by the
    // launch form on every run. The route prunes it on write, which is the
    // key-dropping half of the `mergeWithDefaults` this branch deleted.

    it("prunes a value key that names no declared property and still returns 200", async () => {
      await seedAgent({
        id: "@myorg/orphan-key-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@myorg/orphan-key-agent",
          version: "0.1.0",
          type: "agent",
          description: "Test",
          input: {
            schema: { type: "object", properties: { folder: { type: "string" } } },
          },
        },
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@myorg/orphan-key-agent",
      );

      const res = await app.request("/api/agents/@myorg/orphan-key-agent/input-settings", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        // `legacy_field` was dropped from the schema by a later manifest edit.
        body: JSON.stringify({
          values: { folder: "inbox", legacy_field: "stale" },
          locked_fields: [],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.values).toEqual({ folder: "inbox" });

      const stored = await getInstalledPackageSettings(ctx.defaultAppId, "@myorg/orphan-key-agent");
      expect(stored.values).toEqual({ folder: "inbox" });
      // Pruning is not the same as materialising: a declared property the
      // editor left empty stays ABSENT — `values` is a partial layer.
      expect(Object.keys(stored.values)).toEqual(["folder"]);
    });

    it("stays saveable when the schema declares additionalProperties: false", async () => {
      await seedAgent({
        id: "@myorg/closed-schema-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@myorg/closed-schema-agent",
          version: "0.1.0",
          type: "agent",
          description: "Test",
          input: {
            schema: {
              type: "object",
              properties: { folder: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@myorg/closed-schema-agent",
      );

      const res = await app.request("/api/agents/@myorg/closed-schema-agent/input-settings", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          values: { folder: "inbox", legacy_field: "stale" },
          locked_fields: [],
        }),
      });

      // Pruning happens BEFORE validation, so the orphan key never reaches
      // AJV — otherwise the row would be permanently unsaveable (400 forever).
      expect(res.status).toBe(200);
      const stored = await getInstalledPackageSettings(
        ctx.defaultAppId,
        "@myorg/closed-schema-agent",
      );
      expect(stored.values).toEqual({ folder: "inbox" });
    });

    // ── Locking reconciles existing schedules ─────────────────────────────
    //
    // A schedule that froze a value for a field locked AFTER it was written
    // would fail `locked_input_field` at `resolveEffectiveInput` on every
    // tick — and a failed fire does NOT disable the schedule, so it repeats
    // forever. The lock write drops the frozen key so the field re-resolves
    // from the editor value, exactly as a fresh launch does.

    /** Seed + install an agent with a two-property input schema. */
    async function seedTwoFieldAgent(id: string) {
      await seedAgent({
        id,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: id,
          version: "0.1.0",
          type: "agent",
          description: "Test",
          input: {
            schema: {
              type: "object",
              properties: { folder: { type: "string" }, label: { type: "string" } },
            },
          },
        },
      });
      await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, id);
    }

    /** Create a schedule on `id` through the public route. */
    async function createSchedule(id: string, input: Record<string, unknown>) {
      const res = await app.request(`/api/agents/${id}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ cron_expression: "0 * * * *", input, version_override: "draft" }),
      });
      expect(res.status).toBe(201);
      return (await res.json()) as { id: string };
    }

    const readScheduleRow = async (id: string) =>
      (await db.select().from(schedules).where(eq(schedules.id, id)))[0]!;

    it("drops a newly-locked field from the schedules that froze it, leaving others untouched", async () => {
      const agentId = "@myorg/lock-reconcile-agent";
      await seedTwoFieldAgent(agentId);

      const affected = await createSchedule(agentId, { folder: "inbox", label: "daily" });
      const untouched = await createSchedule(agentId, { label: "weekly" });
      const untouchedBefore = await readScheduleRow(untouched.id);

      const res = await app.request(`/api/agents/${agentId}/input-settings`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ values: { folder: "archive" }, locked_fields: ["folder"] }),
      });
      expect(res.status).toBe(200);

      // The schedule that froze `folder` keeps everything else it froze.
      const affectedRow = await readScheduleRow(affected.id);
      expect(affectedRow.input).toEqual({ label: "daily" });
      // …and is still enabled: the lock is reconciled, not punished.
      expect(affectedRow.enabled).toBe(true);

      // A schedule naming no locked field is not rewritten at all.
      const untouchedRow = await readScheduleRow(untouched.id);
      expect(untouchedRow.input).toEqual({ label: "weekly" });
      expect(untouchedRow.updatedAt).toEqual(untouchedBefore.updatedAt);
    });

    it("leaves the reconciled schedule firing successfully instead of failing every tick", async () => {
      const agentId = "@myorg/lock-fire-agent";
      await seedTwoFieldAgent(agentId);
      const schedule = await createSchedule(agentId, { folder: "inbox" });

      const res = await app.request(`/api/agents/${agentId}/input-settings`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ values: { folder: "archive" }, locked_fields: ["folder"] }),
      });
      expect(res.status).toBe(200);

      // Replay the exact predicate the BullMQ worker evaluates at fire time
      // (`triggerScheduledRun` → `resolveEffectiveInput`): stored settings
      // plus the schedule's frozen values. Before the fix this threw
      // `locked_input_field` on every tick, forever.
      const stored = await getInstalledPackageSettings(ctx.defaultAppId, agentId);
      const row = await readScheduleRow(schedule.id);
      const effective = resolveEffectiveInput({
        schema: asJSONSchemaObject({
          type: "object",
          properties: { folder: { type: "string" }, label: { type: "string" } },
        }),
        editorDefaults: stored.values,
        lockedFields: stored.locked,
        overlay: { origin: "schedule input", values: row.input as Record<string, unknown> },
      });
      // The locked field resolves from the CURRENT editor value.
      expect(effective).toEqual({ folder: "archive" });

      // The schedule is also still enabled and still frozen-input-free, so the
      // next tick has nothing left to trip over.
      expect(row.enabled).toBe(true);
      expect(row.input).toEqual({});
    });

    // ─── 16 KB byte cap on the stored document ─────────────────────────────
    //
    // `application_packages.input_settings` is read on EVERY run launch
    // (`getInstalledPackageSettings`) and on every agent-detail load, yet
    // neither of its members was bounded: `values` is pruned to the schema's
    // declared properties but a declared string's LENGTH is not, and
    // `locked_fields` is stored verbatim without being pruned at all. The only
    // ceiling was the global 10 MiB body limit — 640× the cap on the column's
    // closest sibling, `package_schedules.input` (16 KB).
    //
    // The cap lives in `updateInstalledPackage`, the column's ONE write path,
    // not in the route body schema: the route is not the only caller, and a
    // caller that never sees `agentInputSettingsSchema` must be refused too.

    /** Seed + install an agent whose single input field is free text. */
    async function seedNoteAgent(id: string) {
      await seedAgent({
        id,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: id,
          version: "0.1.0",
          type: "agent",
          description: "Test",
          input: { schema: { type: "object", properties: { note: { type: "string" } } } },
        },
      });
      await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, id);
    }

    /** A `values` document whose JSON weighs well over 16 KB — and well under
     *  the 10 MiB body limit, so nothing upstream refuses it first. */
    const overCapValues = { note: "x".repeat(64 * 1024) };

    it("refuses an over-cap document through the public route, naming the field", async () => {
      const agentId = "@myorg/over-cap-agent";
      await seedNoteAgent(agentId);

      const res = await app.request(`/api/agents/${agentId}/input-settings`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ values: overCapValues, locked_fields: [] }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors?: { field: string; message: string }[] };
      expect(body.errors?.[0]?.field).toBe("input_settings");
      expect(body.errors?.[0]?.message).toMatch(/max is 16384/);

      // Nothing reached Postgres: the row still holds the empty default
      // `installPackage` wrote.
      const stored = await getInstalledPackageSettings(ctx.defaultAppId, agentId);
      expect(stored.values).toEqual({});
    });

    it("refuses an over-cap document written straight through the service", async () => {
      const agentId = "@myorg/over-cap-service-agent";
      await seedNoteAgent(agentId);

      await expect(
        updateInstalledPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, agentId, {
          inputSettings: { values: overCapValues, locked: [] },
        }),
      ).rejects.toThrow(/max is 16384/);

      const stored = await getInstalledPackageSettings(ctx.defaultAppId, agentId);
      expect(stored.values).toEqual({});
    });

    it("still accepts a fat but realistic document", async () => {
      // Guard against a cap that legitimate use hits: a 4 KB instruction
      // template is comfortably storable.
      const agentId = "@myorg/under-cap-agent";
      await seedNoteAgent(agentId);
      const note = "x".repeat(4 * 1024);

      const res = await app.request(`/api/agents/${agentId}/input-settings`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ values: { note }, locked_fields: ["note"] }),
      });

      expect(res.status).toBe(200);
      const stored = await getInstalledPackageSettings(ctx.defaultAppId, agentId);
      expect(stored.values).toEqual({ note });
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

    it("rejects generation settings unsupported by the selected provider", async () => {
      await seedModelAgent();
      const credential = await seedOrgModelProviderOAuth({
        orgId: ctx.orgId,
        providerId: "codex",
      });
      const model = await seedOrgModel({
        orgId: ctx.orgId,
        credentialId: credential.id,
        modelId: "gpt-5.6-luna",
      });

      const res = await app.request("/api/agents/@myorg/model-agent/model", {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: model.id, generation: { temperature: 0.4 } }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_request", param: "generation" });

      const get = await app.request("/api/agents/@myorg/model-agent/model", {
        headers: authHeaders(ctx),
      });
      expect(await get.json()).toMatchObject({ modelId: null, generation: null });
    });

    it("reconciles persisted generation defaults when the model changes", async () => {
      await seedModelAgent();
      await updateInstalledPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@myorg/model-agent",
        { generationConfig: { temperature: 0.7 } },
      );
      const credential = await seedOrgModelProviderOAuth({
        orgId: ctx.orgId,
        providerId: "codex",
      });
      const model = await seedOrgModel({
        orgId: ctx.orgId,
        credentialId: credential.id,
        modelId: "gpt-5.6-luna",
      });

      const res = await putModel(model.id);

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ modelId: model.id, generation: {} });
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
