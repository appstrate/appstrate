// SPDX-License-Identifier: Apache-2.0

/**
 * Lecture de la carte de logique d'un agent.
 *
 * Symétrique de `agent-map.ts`, avec une différence de nature : la carte de dépendances se
 * calcule à la demande depuis le manifeste et l'installation, celle-ci est un artefact
 * **dérivé** que quelqu'un a produit une fois et rangé dans `package_logic_maps`.
 *
 * Ce service ne produit donc rien : il relit la carte stockée, la place et la croise avec ce
 * que le manifeste autorise. Les trois calculs sont des fonctions pures de `@appstrate/core`,
 * ce qui les rend testables sans base et réutilisables par le chat ou le copilote.
 *
 * Rien n'est jamais écrit ici. Le prompt reste la seule source de vérité, la carte en est une
 * projection en lecture seule.
 */

import type { Context } from "hono";
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packageLogicMaps, packageVersions } from "@appstrate/db/schema";
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import { RUNTIME_TOOL_CATALOG } from "@appstrate/core/runtime-tools-catalog";
import {
  crossCheckLogicMap,
  flowNodeRatio,
  type DeclaredCapabilities,
  type LogicMapFinding,
} from "@appstrate/core/logic-map-crosscheck";
import { layoutLogicMap, type LayoutMap } from "@appstrate/core/logic-map-layout";
import type { AppEnv } from "../types/index.ts";
import { getPackageWithAccess } from "./package-catalog.ts";
import { getLatestVersionId, resolveVersion } from "./package-versions.ts";

export interface AgentLogicMapResponse {
  agent: { packageId: string; version: string; integrity: string };
  /** `null` tant qu'aucune carte n'a été produite pour cette version. */
  map: unknown | null;
  nodes: ReturnType<typeof layoutLogicMap>["nodes"];
  groups: ReturnType<typeof layoutLogicMap>["groups"];
  edges: { from: string; to: string; condition: string | null }[];
  diagnostics: LogicMapFinding[];
  meta: {
    generated_at: string | null;
    generator_kind: string | null;
    overall_confidence: number | null;
    /** `true` quand l'empreinte de la carte ne correspond plus à la version installée. */
    stale: boolean;
    /** Part de nœuds de flot : sépare les familles et signale un hybride. */
    flow_ratio: number;
  };
}

/** Ce que le manifeste déclare, projeté dans le vocabulaire des références de la carte. */
function declaredFromManifest(manifest: Record<string, unknown>): DeclaredCapabilities {
  const integrations = parseManifestIntegrations(manifest);
  const mcpServers = Object.entries(
    (manifest["dependencies"] as { mcp_servers?: Record<string, string> } | undefined)
      ?.mcp_servers ?? {},
  ).map(([id]) => ({ id }));
  const skills = Object.keys(
    (manifest["dependencies"] as { skills?: Record<string, string> } | undefined)?.skills ?? {},
  );
  const granted = (manifest["runtime_tools"] as string[] | undefined) ?? [];
  const io = (key: string): string[] => {
    const envelope = manifest[key] as { schema?: { properties?: Record<string, unknown> } };
    return Object.keys(envelope?.schema?.properties ?? {});
  };

  return {
    toolbox: integrations.map((entry) => ({
      id: entry.id,
      ...(entry.tools !== undefined && entry.tools !== "*"
        ? { tools: [...entry.tools] }
        : entry.tools === "*"
          ? { tools: "*" as const }
          : {}),
    })),
    mcp_servers: mcpServers,
    skills,
    // Les outils injectés à chaque run comptent comme accordés, quoi que dise le manifeste.
    system_tools: [...RUNTIME_TOOL_CATALOG.filter((t) => granted.includes(t.id)).map((t) => t.id)],
    config: io("config"),
    agent_input: io("input"),
    agent_output: io("output"),
    has_output_schema: io("output").length > 0,
  };
}

export async function buildAgentLogicMap(
  c: Context<AppEnv>,
  opts: { itemId: string; version?: string },
): Promise<AgentLogicMapResponse | null> {
  const orgId = c.get("orgId");
  const applicationId = c.get("applicationId");
  const loaded = await getPackageWithAccess(opts.itemId, orgId, applicationId);
  if (!loaded) return null;

  // Une carte est attachée à une VERSION PUBLIÉE : le brouillon change à chaque édition, et
  // une carte de brouillon serait périmée avant d'être lue. Sans version publiée, la réponse
  // est « pas encore cartographié » plutôt qu'une erreur.
  const selector = opts.version?.trim();
  const versionId = selector
    ? await resolveVersion(opts.itemId, selector)
    : await getLatestVersionId(opts.itemId);

  const [version] = versionId
    ? await db
        .select({
          id: packageVersions.id,
          version: packageVersions.version,
          integrity: packageVersions.integrity,
          manifest: packageVersions.manifest,
        })
        .from(packageVersions)
        .where(eq(packageVersions.id, versionId))
        .limit(1)
    : [];

  if (!version) {
    return {
      agent: { packageId: opts.itemId, version: selector ?? "", integrity: "" },
      map: null,
      nodes: [],
      groups: [],
      edges: [],
      diagnostics: [],
      meta: {
        generated_at: null,
        generator_kind: null,
        overall_confidence: null,
        stale: false,
        flow_ratio: 0,
      },
    };
  }
  const manifest = version.manifest as Record<string, unknown>;

  // Cloisonnement : la carte d'un agent local n'est lisible que par son organisation ; celle
  // d'un package système (`org_id IS NULL`) l'est par toute l'instance.
  const [stored] = await db
    .select()
    .from(packageLogicMaps)
    .where(
      and(
        eq(packageLogicMaps.versionId, version.id),
        orgId
          ? or(eq(packageLogicMaps.orgId, orgId), isNull(packageLogicMaps.orgId))
          : isNull(packageLogicMaps.orgId),
      ),
    )
    .limit(1);

  if (!stored) {
    return {
      agent: { packageId: opts.itemId, version: version.version, integrity: version.integrity },
      map: null,
      nodes: [],
      groups: [],
      edges: [],
      diagnostics: [],
      meta: {
        generated_at: null,
        generator_kind: null,
        overall_confidence: null,
        stale: false,
        flow_ratio: 0,
      },
    };
  }

  const logicMap = stored.map as LayoutMap;
  const { nodes, groups } = layoutLogicMap(logicMap);
  const diagnostics = crossCheckLogicMap(logicMap, declaredFromManifest(manifest));

  return {
    agent: { packageId: opts.itemId, version: version.version, integrity: version.integrity },
    map: stored.map,
    nodes,
    groups,
    edges: logicMap.edges.map((e) => ({
      from: e.from,
      to: e.to,
      condition: e.condition ?? null,
    })),
    diagnostics,
    meta: {
      generated_at: stored.generatedAt.toISOString(),
      generator_kind: stored.generatorKind,
      overall_confidence: stored.overallConfidence,
      // L'empreinte est la clé d'invalidation : une carte produite pour une autre version du
      // bundle décrit un prompt qui n'est plus celui-là.
      stale: stored.integrity !== version.integrity,
      flow_ratio: flowNodeRatio(logicMap),
    },
  };
}
