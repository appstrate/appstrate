// SPDX-License-Identifier: Apache-2.0

/**
 * GET /api/agents/:scope/:name/logic-map — inferred logic map of an agent.
 *
 * Where the dependency map is a projection of structured data, this one replays
 * a stored artefact, so the invariants worth asserting are different:
 *
 *   - a version nobody mapped answers "not mapped yet" rather than 404 — that is
 *     the normal state of every agent before a cartographer ever runs,
 *   - the stored map comes back laid out (positions computed server-side) and
 *     cross-checked (findings routed to the node they belong to),
 *   - a map produced against another bundle integrity is reported STALE, because
 *     it describes a prompt that is no longer this one,
 *   - a reference the manifest does not declare is an error, while a runtime
 *     capability such as `bash` — which has no declaration slot at all — stays a
 *     hint. Turning it into an error would trade a false negative for a false
 *     positive on every agent that shells out.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { packageDistTags, packageLogicMaps } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedPackageVersion } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";

interface LogicMapBody {
  map: unknown | null;
  nodes: { position: { x: number; y: number }; height: number }[];
  edges: { from: string; to: string; condition: string | null }[];
  diagnostics: {
    level: string;
    code: string;
    node_id: string | null;
    item_id: string | null;
    step_ids: string[];
  }[];
  meta: {
    generated_at: string | null;
    generator_kind: string | null;
    stale: boolean;
    flow_ratio: number;
  };
}

const app = getTestApp();
const AGENT = "@logicorg/agent";
const [SCOPE, NAME] = ["logicorg", "agent"];
// Le `@` reste littéral dans le chemin : les routes Hono matchent l'identifiant brut.
const MAP_URL = `/api/agents/@${SCOPE}/${NAME}/logic-map`;

const MANIFEST = {
  name: AGENT,
  version: "1.0.0",
  type: "agent",
  dependencies: { integrations: { "@logicorg/gmail": "^1.0.0" }, skills: {}, mcp_servers: {} },
  integrations_configuration: { "@logicorg/gmail": { tools: ["api_call"] } },
  runtime_tools: ["output", "log"],
  output: { schema: { type: "object", properties: { summary: { type: "string" } } } },
};

/** A minimal but realistic map: one flow step, one emit, one guard off the flow. */
const MAP = {
  map_version: 1,
  shape: "sequence",
  source: { package_id: AGENT, version: "1.0.0", integrity: "sha256-v1", files: ["prompt.md"] },
  generated_at: "2026-07-28T00:00:00Z",
  generator: { kind: "human" },
  summary: "Relève des messages et rend un résumé.",
  steps: [
    {
      id: "s1",
      kind: "tool_call",
      group: "1. Collecte",
      label: "Lister les messages",
      refs: ["toolbox:@logicorg/gmail#api_call"],
      evidence: { file: "prompt.md", lines: [4, 4], quote: "Liste les messages" },
      confidence: 0.95,
    },
    {
      id: "s2",
      kind: "emit",
      group: "2. Sortie",
      label: "Rendre le résumé",
      refs: ["system_tools:output", "agent_output:summary"],
      evidence: { file: "prompt.md", lines: [9, 9], quote: "Renseigne summary" },
      confidence: 0.9,
    },
    {
      id: "g1",
      kind: "guard",
      group: "Garde-fous",
      label: "Ne jamais écrire hors du dossier",
      refs: [],
      evidence: { file: "prompt.md", lines: [12, 12], quote: "N'écris jamais ailleurs" },
      confidence: 0.99,
    },
  ],
  edges: [{ from: "s1", to: "s2", condition: null }],
  gaps: [],
  overall_confidence: 0.94,
};

async function seedMappedAgent(ctx: TestContext) {
  const agent = await seedAgent({
    id: AGENT,
    orgId: ctx.orgId,
    createdBy: ctx.user.id,
    draftManifest: MANIFEST,
    draftContent: "Liste les messages\nRenseigne summary\nN'écris jamais ailleurs",
  });
  await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT);
  const version = await seedPackageVersion({
    packageId: AGENT,
    version: "1.0.0",
    integrity: "sha256-v1",
    manifest: MANIFEST,
  });
  // `latest` is what the route resolves when no version is asked for.
  await db
    .insert(packageDistTags)
    .values({ packageId: AGENT, tag: "latest", versionId: version.id });
  return { agent, version };
}

async function storeMap(versionId: number, orgId: string, integrity: string, map: unknown = MAP) {
  await db.insert(packageLogicMaps).values({
    versionId,
    packageId: AGENT,
    orgId,
    integrity,
    map,
    generatorKind: "human",
    overallConfidence: 0.94,
  });
}

describe("GET /api/agents/:scope/:name/logic-map", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    // Le scope d'un package est le slug de son organisation : les deux doivent coïncider.
    ctx = await createTestContext({ orgSlug: SCOPE });
  });

  it("answers 'not mapped yet' instead of 404 when nothing produced a map", async () => {
    await seedMappedAgent(ctx);
    const res = await app.request(MAP_URL, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LogicMapBody;
    expect(body.map).toBeNull();
    expect(body.nodes).toEqual([]);
    expect(body.meta.generated_at).toBeNull();
  });

  it("returns the stored map, laid out and cross-checked", async () => {
    const { version } = await seedMappedAgent(ctx);
    await storeMap(version.id, ctx.orgId, "sha256-v1");

    const res = await app.request(MAP_URL, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LogicMapBody;

    expect(body.map).not.toBeNull();
    expect(body.nodes).toHaveLength(3);
    // Le placement vient du serveur : le client ne calcule rien.
    for (const node of body.nodes) {
      expect(typeof node.position.x).toBe("number");
      expect(node.height).toBeGreaterThan(0);
    }
    expect(body.edges).toEqual([{ from: "s1", to: "s2", condition: null }]);
    expect(body.meta.stale).toBe(false);
    expect(body.meta.generator_kind).toBe("human");
    // Part de nœuds de flot : deux sur trois, le garde-fou n'en est pas.
    expect(body.meta.flow_ratio).toBeCloseTo(2 / 3, 5);
  });

  it("reports a map built against another bundle as stale", async () => {
    const { version } = await seedMappedAgent(ctx);
    await storeMap(version.id, ctx.orgId, "sha256-OLD");

    const res = await app.request(MAP_URL, {
      headers: authHeaders(ctx),
    });
    const body = (await res.json()) as LogicMapBody;
    expect(body.meta.stale).toBe(true);
  });

  it("flags a reference the manifest does not declare", async () => {
    const { version } = await seedMappedAgent(ctx);
    await storeMap(version.id, ctx.orgId, "sha256-v1", {
      ...MAP,
      steps: [
        {
          ...MAP.steps[0],
          refs: ["toolbox:@logicorg/absent"],
        },
        MAP.steps[1],
      ],
      edges: [],
    });

    const res = await app.request(MAP_URL, {
      headers: authHeaders(ctx),
    });
    const body = (await res.json()) as LogicMapBody;
    const finding = body.diagnostics.find((d) => d.item_id === "@logicorg/absent");
    expect(finding).toBeDefined();
    expect(finding!.level).toBe("error");
    expect(finding!.node_id).toBe("toolbox");
    expect(finding!.step_ids).toContain("s1");
  });

  it("keeps a runtime capability a hint, never an error", async () => {
    const { version } = await seedMappedAgent(ctx);
    await storeMap(version.id, ctx.orgId, "sha256-v1", {
      ...MAP,
      steps: [{ ...MAP.steps[0], refs: ["runtime:bash"] }, MAP.steps[1]],
      edges: [],
    });

    const res = await app.request(MAP_URL, {
      headers: authHeaders(ctx),
    });
    const body = (await res.json()) as LogicMapBody;
    const finding = body.diagnostics.find((d) => d.item_id === "bash");
    expect(finding).toBeDefined();
    expect(finding!.level).toBe("hint");
    expect(body.diagnostics.some((d) => d.level === "error")).toBe(false);
  });

  it("does not leak another organisation's map", async () => {
    const { version } = await seedMappedAgent(ctx);
    const other = await createTestContext({ orgSlug: "otherorg" });
    await storeMap(version.id, other.orgId, "sha256-v1");

    const res = await app.request(MAP_URL, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as LogicMapBody;
    expect(body.map).toBeNull();
  });

  it("requires authentication", async () => {
    await seedMappedAgent(ctx);
    const res = await app.request(MAP_URL);
    expect(res.status).toBe(401);
  });
});
