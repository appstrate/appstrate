// SPDX-License-Identifier: Apache-2.0

/**
 * A DECLARED dependency is resolved from where the DECLARING package lives —
 * never from the organization at large (RBAC spec §6.9, §3.6).
 *
 * `resolveDeclaredSkills` used to filter on `org_id` alone, which made it the
 * one reader that answered for a package no route will show. That answer is
 * not inert, and both halves are asserted here because they fail differently:
 *
 *   1. the agent DETAIL emits each resolved skill's `name` and `description`,
 *      read live off its DRAFT manifest — so an unplaced skill turned the
 *      detail page into a window onto somebody's private workspace, one that
 *      kept showing whatever they edited into it;
 *   2. an UNRESOLVED skill is a blocking readiness error, and readiness is the
 *      gate every run origin passes (`resolveRunPreflight` — the agent run
 *      route, the scheduler tick, remote and inline). So resolving org-wide is
 *      what let the closure through to `RunPackageCatalog`, which carries no
 *      placement predicate of its own and hands the bundle the skill's
 *      published BYTES.
 *
 * The id does not have to be guessed for this to be reachable: the write door
 * (`assertPackageDependenciesAccessible`) only judges references whose package
 * ALREADY EXISTS, so declaring an id nobody has taken yet is accepted, and the
 * reference is never re-judged once the package appears.
 *
 * NEGATIVE CONTROL: every "is hidden" assertion below is paired with the same
 * read after ONE `package_shares` row is inserted. Without that pair the
 * assertions would pass on any refusal at all, including a broken fixture.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { packageShares } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedPackage, seedPublishedVersion, seedSpace } from "../../helpers/seed.ts";
import { collectAgentReadinessErrors } from "../../../src/services/agent-readiness.ts";
import { getPackage } from "../../../src/services/package-catalog.ts";

const app = getTestApp();

/** Lives only in the private skill — the string no read may echo. */
const SECRET_DESC = "the description of a skill nobody was offered";
const SECRET_NAME = "Private Worker";
const SKILL = "@stranger/private-skill";
const AGENT = "@testorg/consumer-agent";

let ctx: TestContext;
/** Somebody else's personal space: private by construction, 404 to everyone but its owner. */
let strangerSpaceId: string;

async function detail(): Promise<{ status: number; text: string; skills: unknown }> {
  const res = await app.request(`/api/packages/agents/${AGENT}`, { headers: authHeaders(ctx) });
  const text = await res.clone().text();
  const body = (await res.json()) as { dependencies?: { skills?: unknown } };
  return { status: res.status, text, skills: body.dependencies?.skills ?? null };
}

async function readiness(): Promise<string[]> {
  const agent = await getPackage(AGENT, ctx.orgId);
  const errors = await collectAgentReadinessErrors({
    agent: agent!,
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    actor: null,
  });
  return errors.filter((e) => e.code === "missing_skill").map((e) => e.field);
}

/** The one row that PLACES the skill where the agent lives. */
async function offerSkillToAgentHome(): Promise<void> {
  await db.insert(packageShares).values({ packageId: SKILL, spaceId: ctx.defaultSpaceId });
}

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext();

  const stranger = await createTestUser();
  const personal = await seedSpace({
    orgId: ctx.orgId,
    name: "Stranger",
    ownerUserId: stranger.id,
    visibility: "private",
  });
  strangerSpaceId = personal.id;

  await seedPackage({
    id: SKILL,
    orgId: ctx.orgId,
    type: "skill",
    homeSpaceId: strangerSpaceId,
    draftManifest: {
      name: SKILL,
      version: "1.0.0",
      type: "skill",
      display_name: SECRET_NAME,
      description: SECRET_DESC,
    },
    draftContent: `---\nname: private\ndescription: d\n---\n\nbody`,
  });
  // Published, because that is the state that makes the closure assemblable:
  // an unpublished skill would fail the bundle for a reason this file does not
  // mean to assert.
  await seedPublishedVersion(SKILL, "1.0.0");

  // The consumer agent is homed in the caller's OWN default space, and simply
  // names the skill. Nothing was ever shared with it.
  await seedPackage({
    id: AGENT,
    orgId: ctx.orgId,
    type: "agent",
    homeSpaceId: ctx.defaultSpaceId,
    draftManifest: {
      name: AGENT,
      version: "1.0.0",
      type: "agent",
      display_name: "Consumer",
      description: "consumes a skill it was never offered",
      input: { schema: { type: "object", properties: {} } },
      dependencies: { skills: { [SKILL]: "*" } },
    },
    draftContent: "do the thing",
  });
});

describe("the skill itself", () => {
  it("is unreachable on its own routes — the premise of everything below", async () => {
    const read = await app.request(`/api/packages/skills/${SKILL}`, { headers: authHeaders(ctx) });
    expect(read.status).toBe(404);

    const index = await app.request("/api/packages/skills", { headers: authHeaders(ctx) });
    expect(await index.text()).not.toContain(SECRET_DESC);
  });
});

describe("the agent detail's dependency projection", () => {
  it("omits a declared skill the agent's home cannot reach, name and description included", async () => {
    const { status, text, skills } = await detail();
    expect(status).toBe(200);
    expect(skills).toEqual([]);
    // The id check alone would miss the actual disclosure: what the projection
    // carries is the skill's own display name and description.
    expect(text).not.toContain(SECRET_NAME);
    expect(text).not.toContain(SECRET_DESC);
  });

  it("emits it once the skill is OFFERED to the agent's home", async () => {
    await offerSkillToAgentHome();

    const { text, skills } = await detail();
    expect(skills).toEqual([
      {
        id: SKILL,
        version: "*",
        name: SECRET_NAME,
        description: SECRET_DESC,
        home_writable: false,
      },
    ]);
    expect(text).toContain(SECRET_DESC);
  });
});

describe("readiness — the gate every run origin passes", () => {
  it("refuses the run while the skill is not placed where the agent lives", async () => {
    expect(await readiness()).toEqual([`dependencies.skills.${SKILL}`]);
  });

  it("clears once the skill is OFFERED to the agent's home", async () => {
    await offerSkillToAgentHome();
    expect(await readiness()).toEqual([]);
  });

  it("says the same thing about a skill that does not exist at all", async () => {
    // The refusal must not tell "not published" from "published somewhere you
    // cannot reach" — the difference is an existence oracle over the whole
    // catalogue, which is why the package routes answer 404 and not 403.
    const agent = await getPackage(AGENT, ctx.orgId);
    const ghost = {
      ...agent!,
      manifest: {
        ...agent!.manifest,
        dependencies: { skills: { "@stranger/no-such-skill": "*" } },
      },
    };
    const errors = await collectAgentReadinessErrors({
      agent: ghost,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: null,
    });
    const ghostMessage = errors.find((e) => e.code === "missing_skill")!.message;

    const hiddenErrors = await collectAgentReadinessErrors({
      agent: agent!,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: null,
    });
    const hiddenMessage = hiddenErrors.find((e) => e.code === "missing_skill")!.message;

    expect(hiddenMessage.replace(SKILL, "X")).toBe(
      ghostMessage.replace("@stranger/no-such-skill", "X"),
    );
  });
});

describe("the anchor is the declaring agent's HOME, not the launching space", () => {
  /**
   * The regression this pairs with: judging the closure against the space a run
   * starts in would break the ordinary case the sharing feature exists for — an
   * agent OFFERED to another space must keep running there with the skills its
   * own home placed beside it, which that space was never given.
   */
  it("resolves a skill placed at the agent's home when the run starts in another space", async () => {
    await offerSkillToAgentHome();
    const recipient = await seedSpace({ orgId: ctx.orgId, name: "Recipient" });
    await db.insert(packageShares).values({ packageId: AGENT, spaceId: recipient.id });

    const agent = await getPackage(AGENT, ctx.orgId);
    const errors = await collectAgentReadinessErrors({
      agent: agent!,
      orgId: ctx.orgId,
      // The launching space, which holds no offer for the SKILL — only for the
      // agent that declares it.
      spaceId: recipient.id,
      actor: null,
    });

    expect(errors.filter((e) => e.code === "missing_skill")).toEqual([]);
  });
});
