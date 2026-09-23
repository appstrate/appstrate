// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  authHeaders,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedAgent,
  seedSpacePackage,
  seedOrgModel,
  seedOrgModelProviderKey,
  seedOrgModelProviderOAuth,
  seedPackageShare,
  seedRun,
  seedSpace,
  seedSpaceMember,
  seedUnreachableSpace,
} from "../../helpers/seed.ts";
import {
  getSystemModels,
  initSystemModelProviderKeys,
} from "../../../src/services/model-registry.ts";
import {
  getSpacePackageSettings,
  activatePackage,
  updateSpacePackage,
} from "../../../src/services/space-packages.ts";
import { createVersionFromDraft } from "../../../src/services/package-versions.ts";
import { assertDbCount } from "../../helpers/assertions.ts";
import { packages, runs, schedules } from "@appstrate/db/schema";
import { addMemories, upsertPinned } from "../../../src/services/state/package-persistence.ts";
import { resolveEffectiveInput } from "../../../src/services/input-resolution.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";

const app = getTestApp();

/** Seed an agent and install it in the default space. */
async function seedActiveAgent(overrides: Parameters<typeof seedAgent>[0] & { spaceId: string }) {
  const { spaceId, ...rest } = overrides;
  const pkg = await seedAgent(rest);
  await seedPackageShare(spaceId, pkg.id);
  await activatePackage({ orgId: rest.orgId!, spaceId: spaceId }, pkg.id);
  return pkg;
}

describe("Agents API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
  });

  /**
   * The scope the service reads under. `getSpacePackageSettings` carries the
   * org boundary and the placement rule in its own query, so a bare space id
   * is not enough to name the row it may act on.
   */
  const spaceScope = () => ({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId });

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

    it("returns agents installed in the current space", async () => {
      await seedActiveAgent({
        id: "@myorg/test-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        spaceId: ctx.defaultSpaceId,
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
      await seedActiveAgent({
        id: "@myorg/scoped-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        spaceId: ctx.defaultSpaceId,
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
      await seedActiveAgent({
        id: "@myorg/detail-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        spaceId: ctx.defaultSpaceId,
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

    it("returns 404 from default space when agent is not installed (no bypass)", async () => {
      await seedAgent({
        id: "@myorg/default-hidden",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        homeSpaceId: await seedUnreachableSpace(ctx.orgId),
      });

      // The organization owns the agent, but it is placed nowhere this space
      // reaches
      const res = await app.request("/api/packages/agents/@myorg/default-hidden", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 200 from default space when agent is installed", async () => {
      await seedActiveAgent({
        id: "@myorg/default-installed",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        spaceId: ctx.defaultSpaceId,
      });

      const res = await app.request("/api/packages/agents/@myorg/default-installed", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe("@myorg/default-installed");
    });

    it("returns 404 from custom space when agent is not installed", async () => {
      await seedAgent({ id: "@myorg/custom-hidden", orgId: ctx.orgId, createdBy: ctx.user.id });

      const customApp = await seedSpace({
        orgId: ctx.orgId,
        name: "Custom Space",
        createdBy: ctx.user.id,
      });

      const res = await app.request("/api/packages/agents/@myorg/custom-hidden", {
        headers: { ...authHeaders(ctx), "X-Space-Id": customApp.id },
      });

      expect(res.status).toBe(404);
    });

    it("returns 200 from custom space when agent is installed", async () => {
      const customApp = await seedSpace({
        orgId: ctx.orgId,
        name: "Custom Installed",
        createdBy: ctx.user.id,
      });
      await seedAgent({
        id: "@myorg/custom-installed",
        homeSpaceId: customApp.id,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      await activatePackage({ orgId: ctx.orgId, spaceId: customApp.id }, "@myorg/custom-installed");

      const res = await app.request("/api/packages/agents/@myorg/custom-installed", {
        headers: { ...authHeaders(ctx), "X-Space-Id": customApp.id },
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
      await seedActiveAgent({
        id: VER,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        spaceId: ctx.defaultSpaceId,
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
        homeSpaceId: ctx.defaultSpaceId,
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
      await activatePackage(
        { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
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
        homeSpaceId: ctx.defaultSpaceId,
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
      await activatePackage(
        { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
        "@myorg/partial-agent",
      );
      await updateSpacePackage(
        { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
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
      const stored = await getSpacePackageSettings(spaceScope(), "@myorg/partial-agent");
      expect(stored.values).toEqual({ folder: "archive" });
      expect(stored.locked).toEqual(["folder"]);
    });

    it("rejects a body carrying an unknown key with 400 and leaves the stored row intact", async () => {
      await seedAgent({
        id: "@myorg/unknown-key-agent",
        homeSpaceId: ctx.defaultSpaceId,
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
      await activatePackage(
        { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
        "@myorg/unknown-key-agent",
      );
      await updateSpacePackage(
        { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
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
      const stored = await getSpacePackageSettings(spaceScope(), "@myorg/unknown-key-agent");
      expect(stored.values).toEqual({ folder: "archive" });
      expect(stored.locked).toEqual(["folder"]);
    });

    it("rejects a wrong-typed stored value with 400", async () => {
      await seedAgent({
        id: "@myorg/typed-agent",
        homeSpaceId: ctx.defaultSpaceId,
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
      await activatePackage(
        { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
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
        homeSpaceId: ctx.defaultSpaceId,
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
      await activatePackage(
        { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
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

      const stored = await getSpacePackageSettings(spaceScope(), "@myorg/orphan-key-agent");
      expect(stored.values).toEqual({ folder: "inbox" });
      // Pruning is not the same as materialising: a declared property the
      // editor left empty stays ABSENT — `values` is a partial layer.
      expect(Object.keys(stored.values)).toEqual(["folder"]);
    });

    it("stays saveable when the schema declares additionalProperties: false", async () => {
      await seedAgent({
        id: "@myorg/closed-schema-agent",
        homeSpaceId: ctx.defaultSpaceId,
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
      await activatePackage(
        { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
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
      const stored = await getSpacePackageSettings(spaceScope(), "@myorg/closed-schema-agent");
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
      await seedPackageShare(ctx.defaultSpaceId, id);
      await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, id);
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
      const stored = await getSpacePackageSettings(spaceScope(), agentId);
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
    // `space_packages.input_settings` is read on EVERY run launch
    // (`getSpacePackageSettings`) and on every agent-detail load, yet
    // neither of its members was bounded: `values` is pruned to the schema's
    // declared properties but a declared string's LENGTH is not, and
    // `locked_fields` is stored verbatim without being pruned at all. The only
    // ceiling was the global 10 MiB body limit — 640× the cap on the column's
    // closest sibling, `package_schedules.input` (16 KB).
    //
    // The cap lives in `updateSpacePackage`, the column's ONE write path,
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
      await seedPackageShare(ctx.defaultSpaceId, id);
      await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, id);
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
      // `activatePackage` wrote.
      const stored = await getSpacePackageSettings(spaceScope(), agentId);
      expect(stored.values).toEqual({});
    });

    it("refuses an over-cap document written straight through the service", async () => {
      const agentId = "@myorg/over-cap-service-agent";
      await seedNoteAgent(agentId);

      await expect(
        updateSpacePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, agentId, {
          inputSettings: { values: overCapValues, locked: [] },
        }),
      ).rejects.toThrow(/max is 16384/);

      const stored = await getSpacePackageSettings(spaceScope(), agentId);
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
      const stored = await getSpacePackageSettings(spaceScope(), agentId);
      expect(stored.values).toEqual({ note });
    });
  });

  describe("GET /api/agents/:scope/:name/bundle — 404 distinction", () => {
    // `requireAgent()` distinguishes "this space holds no placement for the
    // agent" from "it holds one that is switched off" — the CLI's run-by-id
    // flow needs to tell the user whether to fix the spelling or activate the
    // agent. The opaque code is the DEFAULT: a space with no placement learns
    // nothing about the agent, so only the placed-but-off case is named. Pin
    // both branches so the contract holds across refactors.

    it("returns 404 agent_not_found when the package isn't in the org catalog", async () => {
      const res = await app.request("/api/agents/@myorg/does-not-exist/bundle", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code?: string; detail?: string };
      expect(body.code).toBe("agent_not_found");
    });

    it("keeps the OPAQUE code when the org has the package but this space holds no placement", async () => {
      // Homed out of reach and offered nowhere here: the space is told
      // nothing. Naming "exists but is not placed here" would hand any member
      // an existence oracle over every id in the organization.
      await seedAgent({
        id: "@myorg/inactive-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        homeSpaceId: await seedUnreachableSpace(ctx.orgId),
      });

      const res = await app.request("/api/agents/@myorg/inactive-agent/bundle", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code?: string; detail?: string };
      expect(body.code).toBe("agent_not_found");
      expect(body.detail).not.toContain("/api/spaces/");
    });

    it("says PLACED-but-off when the row is there and disabled — same 404, different reading", async () => {
      // The negative control on R19: before it, a disabled placement RAN. Now
      // it answers the same 404 as no placement at all, and the message is the
      // only thing that distinguishes "one click away" from "never offered".
      await seedActiveAgent({
        id: "@myorg/switched-off-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        spaceId: ctx.defaultSpaceId,
      });
      await seedSpacePackage(ctx.defaultSpaceId, "@myorg/switched-off-agent", { enabled: false });

      const res = await app.request("/api/agents/@myorg/switched-off-agent/bundle", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code?: string; detail?: string };
      expect(body.code).toBe("agent_not_active_in_space");
      expect(body.detail).toContain("but not active there");
      // The detail names the space and the activation endpoint so the CLI's
      // hint can quote it back to the user verbatim.
      expect(body.detail).toContain(ctx.defaultSpaceId);
      expect(body.detail).toContain("/api/spaces/");
    });

    it("passes the access gate when the package is active (subsequent failures are version/artifact, not access)", async () => {
      // The 200/version-resolution path requires a published artifact in
      // storage that the seed helpers don't set up. The relevant contract
      // for *this* gate is that we don't surface `agent_not_active_in_space`
      // for an active package — version-resolution failures throw
      // `not_found`, a different code.
      await seedActiveAgent({
        id: "@myorg/active-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        spaceId: ctx.defaultSpaceId,
      });

      const res = await app.request("/api/agents/@myorg/active-agent/bundle", {
        headers: authHeaders(ctx),
      });
      const body = (await res.json()) as { code?: string };
      expect(body.code).not.toBe("agent_not_active_in_space");
      expect(body.code).not.toBe("agent_not_found");
    });
  });

  describe("GET /api/agents/:scope/:name/bundle?source=draft — UI parity path", () => {
    // Pin the dashboard-Run-button parity contract. A never-published
    // agent must bundle its draft state via `?source=draft`, otherwise
    // `appstrate run @scope/agent` fails with `no_published_version`
    // on agents the dashboard runs happily.

    it("returns 200 + a deterministic .afps-bundle for an installed never-published agent", async () => {
      await seedActiveAgent({
        id: "@myorg/draft-only",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        spaceId: ctx.defaultSpaceId,
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
      await seedActiveAgent({
        id: "@myorg/draft-with-version",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        spaceId: ctx.defaultSpaceId,
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
      // On an ACTIVE agent: the route mounts `requireAgent()` like every other
      // execution door, so an agent this space cannot run answers its 404 first
      // — a query-string 400 is never a free reachability probe.
      await seedActiveAgent({
        id: "@myorg/anything",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        spaceId: ctx.defaultSpaceId,
      });
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
      await seedActiveAgent({
        id: "@myorg/counted-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        spaceId: ctx.defaultSpaceId,
      });
      await seedRun({
        packageId: "@myorg/counted-agent",
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        status: "success",
      });
      await seedRun({
        packageId: "@myorg/counted-agent",
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
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
      await seedActiveAgent({
        id: "@myorg/persist-list",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        spaceId: ctx.defaultSpaceId,
      });

      // Two distinct scopes write pinned `checkpoint` slots
      await upsertPinned(
        "@myorg/persist-list",
        ctx.defaultSpaceId,
        ctx.orgId,
        { type: "user", id: ctx.user.id },
        "checkpoint",
        { step: "user-checkpoint" },
        null,
      );
      await upsertPinned(
        "@myorg/persist-list",
        ctx.defaultSpaceId,
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
      await seedActiveAgent({
        id: "@myorg/persist-named-pin",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        spaceId: ctx.defaultSpaceId,
      });

      // Mix of keys: `checkpoint` + Letta-style `persona` + `goals`
      await upsertPinned(
        "@myorg/persist-named-pin",
        ctx.defaultSpaceId,
        ctx.orgId,
        { type: "shared" },
        "checkpoint",
        { step: "carry-over" },
        null,
      );
      await upsertPinned(
        "@myorg/persist-named-pin",
        ctx.defaultSpaceId,
        ctx.orgId,
        { type: "shared" },
        "persona",
        "Senior coding assistant",
        null,
      );
      await upsertPinned(
        "@myorg/persist-named-pin",
        ctx.defaultSpaceId,
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
      await seedActiveAgent({
        id: "@myorg/persist-runid",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        spaceId: ctx.defaultSpaceId,
      });
      const r1 = await seedRun({
        packageId: "@myorg/persist-runid",
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        status: "success",
      });
      const r2 = await seedRun({
        packageId: "@myorg/persist-runid",
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        status: "success",
      });
      await addMemories(
        "@myorg/persist-runid",
        ctx.defaultSpaceId,
        ctx.orgId,
        { type: "user", id: ctx.user.id },
        ["from-r1-a", "from-r1-b"],
        r1.id,
      );
      await addMemories(
        "@myorg/persist-runid",
        ctx.defaultSpaceId,
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
      const body = (await res.json()) as { object: string; memories: Array<{ runId: string }> };
      expect(body.object).toBe("agent_persistence");
      expect(body.memories).toHaveLength(2);
      expect(body.memories.every((m) => m.runId === r1.id)).toBe(true);
    });
  });

  describe("DELETE /api/agents/:scope/:name/persistence/pinned/:id", () => {
    it("deletes a single pinned slot by id", async () => {
      await seedActiveAgent({
        id: "@myorg/persist-del-cp",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        spaceId: ctx.defaultSpaceId,
      });
      await upsertPinned(
        "@myorg/persist-del-cp",
        ctx.defaultSpaceId,
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
      await seedActiveAgent({
        id: "@myorg/persist-del-persona",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        spaceId: ctx.defaultSpaceId,
      });
      await upsertPinned(
        "@myorg/persist-del-persona",
        ctx.defaultSpaceId,
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
      await seedActiveAgent({
        id: "@myorg/persist-del-404",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        spaceId: ctx.defaultSpaceId,
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
      await seedActiveAgent({
        id: "@myorg/proxy-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        spaceId: ctx.defaultSpaceId,
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

  describe("PATCH /api/agents/:scope/:name/model", () => {
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
      await seedActiveAgent({
        id: "@myorg/model-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        spaceId: ctx.defaultSpaceId,
      });
    }

    function patchModel(modelId: string | null, headers = authHeaders(ctx)) {
      return app.request("/api/agents/@myorg/model-agent/model", {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
    }

    it("returns the bare model-setting resource (same shape as GET)", async () => {
      await seedModelAgent();
      const key = await seedOrgModelProviderKey({ orgId: ctx.orgId });
      const model = await seedOrgModel({ orgId: ctx.orgId, credentialId: key.id });

      const res = await patchModel(model.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { modelId: string | null } & Record<string, unknown>;
      // Bare model-setting resource — no `success` scrap (#657).
      expect(body.modelId).toBe(model.id);
      expect("success" in body).toBe(false);

      // Reverting to org default returns the null resource, not a stub.
      const revert = await patchModel(null);
      expect(revert.status).toBe(200);
      const revertBody = (await revert.json()) as { modelId: string | null };
      expect(revertBody.modelId).toBeNull();
    });

    it("accepts a system model preset id", async () => {
      await seedModelAgent();

      const res = await patchModel(SYSTEM_PRESET);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { modelId: string | null };
      expect(body.modelId).toBe(SYSTEM_PRESET);
    });

    it("rejects an unknown model id with 404 and does not persist it (#960)", async () => {
      await seedModelAgent();

      const res = await patchModel("raw-upstream-model-name");
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
        method: "PATCH",
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

    // The "no model resolves" refusal was written out four times across
    // `agents.ts`, `spaces.ts` and the two schedule handlers — same literal
    // message, and NONE of the four carried an RFC 9457 `param` (only their
    // `ModelGenerationError` sibling did). All four now go through one
    // `validateGenerationOverride`, which gives both refusals the same `param`,
    // so every route names its own wire field. That is a deliberate change to
    // the 400 body — see the rationale on `validateGenerationOverride` — and
    // this case plus its three siblings (`spaces.test.ts`, two in
    // `schedules.test.ts`) are what pin it.
    it("names the generation field when no model resolves at all", async () => {
      await seedModelAgent();

      const res = await app.request("/api/agents/@myorg/model-agent/model", {
        method: "PATCH",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: null, generation: { temperature: 0.4 } }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: "invalid_request",
        param: "generation",
        detail: "A model must be configured before generation settings can be saved",
      });
    });

    it("reconciles persisted generation defaults when the model changes", async () => {
      await seedModelAgent();
      await updateSpacePackage(
        { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
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

      const res = await patchModel(model.id);

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

      const res = await patchModel(otherModel.id);
      expect(res.status).toBe(404);

      const get = await app.request("/api/agents/@myorg/model-agent/model", {
        headers: authHeaders(ctx),
      });
      const body = (await get.json()) as { modelId: string | null };
      expect(body.modelId).toBeNull();
    });
  });
});

/**
 * Reading a package is not executing it (RBAC spec §6.10).
 *
 * An agent nobody has published yet has exactly ONE definition — the author's
 * draft. The package list shows it to every reader of its home, so its detail
 * page has to exist for them too: a 404 there is a link the list just promised
 * and cannot honour, and hiding the page protects nothing (`GET …/files` and
 * the list already show the same draft).
 *
 * The refusals stay where they belong. Naming the working copy — an explicit
 * `?version=draft` — is an author's act and answers `403 draft_not_writable`.
 * LAUNCHING with no selector is the published version and answers
 * `404 no_published_version`. The `definition` field is what lets a client tell
 * the two situations apart and say so instead of offering a dead button.
 */
describe("GET /api/packages/agents/:scope/:name — a never-published agent is readable", () => {
  let ctx: TestContext;
  let homeId: string;
  const NEVER = "@myorg/never-published";

  /** A member holding `preset` in the agent's home, and nothing elsewhere. */
  async function memberIn(preset: "viewer" | "operator" | "builder") {
    const user = await createTestUser();
    await addOrgMember(ctx.orgId, user.id, "member");
    await seedSpaceMember({ spaceId: homeId, userId: user.id, presetRole: preset });
    return { Cookie: user.cookie, "X-Org-Id": ctx.orgId, "X-Space-Id": homeId };
  }

  const detail = (headers: Record<string, string>, suffix = "") =>
    app.request(`/api/packages/agents/${NEVER}${suffix}`, { headers });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    homeId = (await seedSpace({ orgId: ctx.orgId, name: "Home", visibility: "closed" })).id;
    await seedAgent({
      id: NEVER,
      homeSpaceId: homeId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: NEVER,
        version: "0.1.0",
        type: "agent",
        description: "Work in progress",
      },
      draftContent: "The author's working copy.",
    });
    await seedSpacePackage(homeId, NEVER);
  });

  for (const preset of ["viewer", "operator"] as const) {
    it(`serves the draft in read-only to a ${preset} of the home`, async () => {
      const headers = await memberIn(preset);
      // The control: the list DOES show it, which is what makes a 404 on the
      // detail a contradiction rather than a policy.
      const listed = await app.request("/api/agents", { headers });
      expect(listed.status, await listed.clone().text()).toBe(200);
      expect(
        ((await listed.json()) as { data: { id: string }[] }).data.map((row) => row.id),
      ).toContain(NEVER);

      const res = await detail(headers);
      expect(res.status, await res.clone().text()).toBe(200);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({
        id: NEVER,
        definition: "draft",
        home_writable: false,
      });
    });
  }

  it("still refuses an EXPLICIT ?version=draft to a reader who cannot write it", async () => {
    // The discriminating pair: the same caller, the same agent, the same
    // definition — only the selector changes. Naming the working copy is the
    // author's act; landing on it because nothing else exists is not.
    const headers = await memberIn("operator");
    expect((await detail(headers)).status).toBe(200);
    const named = await detail(headers, "?version=draft");
    expect(named.status, await named.clone().text()).toBe(403);
    expect((await named.json()) as { code?: string }).toMatchObject({
      code: "draft_not_writable",
    });
  });

  it("answers readiness on the SAME definition the page rendered", async () => {
    // The badge and the page must judge the SAME definition. Deriving the
    // default selector in two places is how one of them 404s what the other
    // has just rendered, so both read `defaultDefinitionSelector`.
    const headers = await memberIn("operator");
    const res = await app.request(`/api/agents/${NEVER}/connection-readiness`, { headers });
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it("keeps the LAUNCH refused — reading is not executing", async () => {
    const headers = await memberIn("operator");
    const res = await app.request(`/api/agents/${NEVER}/run`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    expect(res.status, await res.clone().text()).toBe(404);
    expect((await res.json()) as { code?: string }).toMatchObject({
      code: "no_published_version",
    });
  });

  it("reports `definition: published` once a version exists, for the same reader", async () => {
    // The other half of the field's meaning: with something published, a
    // non-author reads THAT, not the author's in-flight edits.
    await createVersionFromDraft({ packageId: NEVER, orgId: ctx.orgId, userId: ctx.user.id });
    const headers = await memberIn("operator");
    const res = await detail(headers);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      definition: "published",
      home_writable: false,
    });
  });

  it("reports `definition: draft` to the author, published or not", async () => {
    await createVersionFromDraft({ packageId: NEVER, orgId: ctx.orgId, userId: ctx.user.id });
    const headers = await memberIn("builder");
    const res = await detail(headers);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      definition: "draft",
      home_writable: true,
    });
  });
});
