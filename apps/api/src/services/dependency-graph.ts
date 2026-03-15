import { eq, and, or, isNull } from "drizzle-orm";
import { isValidVersion, versionGt } from "@appstrate/core/semver";
import { parseScopedName } from "@appstrate/core/naming";
import type { PackageType } from "./package-items/config.ts";
import { db } from "../lib/db.ts";
import { packages, packageDependencies } from "@appstrate/db/schema";
import { getRegistryClient } from "./registry-provider.ts";
import { logger } from "../lib/logger.ts";

// --- Types ---

export interface GraphNode {
  packageId: string;
  type: PackageType;
  displayName: string;
  version: string | null;
  registryVersion: string | null;
  source: string;
}

export interface DependencyGraph {
  nodes: Map<string, GraphNode>;
  edges: Map<string, Set<string>>; // packageId → dependencyIds
}

export type PublishStatus =
  | "unpublished"
  | "outdated"
  | "published"
  | "no_version"
  | "version_behind"
  | "system";

export interface PublishPlanItem {
  packageId: string;
  type: PackageType;
  displayName: string;
  version: string | null;
  registryVersion: string | null;
  status: PublishStatus;
}

export interface PublishPlan {
  items: PublishPlanItem[];
  circular: string[] | null;
}

// --- Pure functions ---

export function computePublishStatus(node: GraphNode): PublishStatus {
  if (node.source === "system") return "system";
  const { version, registryVersion } = node;
  if (!version || !isValidVersion(version)) return "no_version";
  if (!registryVersion) return "unpublished";
  if (version === registryVersion) return "published";
  if (versionGt(version, registryVersion)) return "outdated";
  return "version_behind";
}

export function topoSort(graph: DependencyGraph): { order: string[]; circular: string[] | null } {
  // Kahn's algorithm: depCount = number of unresolved dependencies per node.
  // Nodes with 0 deps are processed first → deps-before-dependents order.
  const depCount = new Map<string, number>();
  for (const id of graph.nodes.keys()) {
    depCount.set(id, 0);
  }

  for (const [id, deps] of graph.edges) {
    depCount.set(id, deps.size);
  }

  const queue: string[] = [];
  for (const [id, count] of depCount) {
    if (count === 0) queue.push(id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);

    // For each node that depends on current, decrement its dep count
    for (const [id, deps] of graph.edges) {
      if (deps.has(current)) {
        const newCount = (depCount.get(id) ?? 1) - 1;
        depCount.set(id, newCount);
        if (newCount === 0) queue.push(id);
      }
    }
  }

  if (order.length < graph.nodes.size) {
    const remaining = [...graph.nodes.keys()].filter((id) => !order.includes(id));
    return { order, circular: remaining };
  }

  return { order, circular: null };
}

// --- Async functions (DB access) ---

export async function buildGraph(rootId: string, orgId: string): Promise<DependencyGraph> {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, Set<string>>();
  const queue = [rootId];

  while (queue.length > 0) {
    const packageId = queue.shift()!;
    if (nodes.has(packageId)) continue;

    const [pkg] = await db
      .select({
        id: packages.id,
        type: packages.type,
        draftManifest: packages.draftManifest,
        source: packages.source,
      })
      .from(packages)
      .where(and(eq(packages.id, packageId), or(eq(packages.orgId, orgId), isNull(packages.orgId))))
      .limit(1);

    if (!pkg) continue;

    const manifest = (pkg.draftManifest ?? {}) as Record<string, unknown>;
    const displayName = (manifest.displayName as string) || (manifest.name as string) || packageId;
    const version = manifest.version as string | null;

    nodes.set(packageId, {
      packageId,
      type: pkg.type,
      displayName,
      version,
      registryVersion: null, // populated by fetchRegistryVersions() in getPublishPlan()
      source: pkg.source,
    });

    const deps = await db
      .select({ dependencyId: packageDependencies.dependencyId })
      .from(packageDependencies)
      .where(
        and(eq(packageDependencies.packageId, packageId), eq(packageDependencies.orgId, orgId)),
      );

    const depIds = new Set<string>();
    for (const dep of deps) {
      depIds.add(dep.dependencyId);
      if (!nodes.has(dep.dependencyId)) {
        queue.push(dep.dependencyId);
      }
    }
    edges.set(packageId, depIds);
  }

  return { nodes, edges };
}

/**
 * Query the registry for the latest published version of each non-system package.
 * Returns a map from packageId → latest version string (or null if not found).
 * Gracefully falls back to empty map if the registry is unreachable.
 */
async function fetchRegistryVersions(packageIds: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const client = getRegistryClient();
  if (!client || packageIds.length === 0) return result;

  const lookups = packageIds.map(async (id) => {
    const parsed = parseScopedName(id);
    if (!parsed) return;
    try {
      const detail = await client.getPackage(`@${parsed.scope}`, parsed.name);
      // Find the "latest" dist-tag to get the current published version
      const latestTag = detail.distTags?.find((t) => t.tag === "latest");
      if (latestTag) {
        const ver = detail.versions.find((v) => v.id === latestTag.versionId);
        if (ver) {
          result.set(id, ver.version);
          return;
        }
      }
      // Fallback: highest non-yanked version
      const published = detail.versions.filter((v) => !v.yanked);
      if (published.length > 0) {
        const sorted = published.sort((a, b) => (versionGt(a.version, b.version) ? -1 : 1));
        result.set(id, sorted[0]!.version);
      }
    } catch {
      // Package not on registry or network error — leave unset
    }
  });

  await Promise.all(lookups);
  return result;
}

export async function getPublishPlan(
  rootId: string,
  orgId: string,
  targetVersion?: string,
): Promise<PublishPlan> {
  const graph = await buildGraph(rootId, orgId);

  if (graph.nodes.size === 0) {
    return { items: [], circular: null };
  }

  // Override root node version if targetVersion specified
  if (targetVersion && graph.nodes.has(rootId)) {
    const rootNode = graph.nodes.get(rootId)!;
    graph.nodes.set(rootId, { ...rootNode, version: targetVersion });
  }

  // Query registry for actual published versions (source of truth)
  const nonSystemIds = [...graph.nodes.values()]
    .filter((n) => n.source !== "system")
    .map((n) => n.packageId);

  const registryVersions = await fetchRegistryVersions(nonSystemIds).catch((err) => {
    logger.warn("Could not fetch registry versions for publish plan", {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map<string, string | null>();
  });

  // Update graph nodes with registry data
  for (const [id, registryVersion] of registryVersions) {
    const node = graph.nodes.get(id);
    if (node) {
      graph.nodes.set(id, { ...node, registryVersion: registryVersion });
    }
  }

  const { order, circular } = topoSort(graph);

  if (circular) {
    return { items: [], circular };
  }

  const items: PublishPlanItem[] = order.map((id) => {
    const node = graph.nodes.get(id)!;
    return {
      packageId: node.packageId,
      type: node.type,
      displayName: node.displayName,
      version: node.version,
      registryVersion: node.registryVersion,
      status: computePublishStatus(node),
    };
  });

  return { items, circular: null };
}
