import { eq, and } from "drizzle-orm";
import { isValidVersion } from "@appstrate/core/semver";
import { db } from "../lib/db.ts";
import { packages, packageDependencies } from "@appstrate/db/schema";

// --- Types ---

export interface GraphNode {
  packageId: string;
  type: "flow" | "skill" | "extension";
  displayName: string;
  version: string | null;
  lastPublishedVersion: string | null;
  source: string;
}

export interface DependencyGraph {
  nodes: Map<string, GraphNode>;
  edges: Map<string, Set<string>>; // packageId → dependencyIds
}

export type PublishStatus = "unpublished" | "outdated" | "published" | "no_version";

export interface PublishPlanItem {
  packageId: string;
  type: "flow" | "skill" | "extension";
  displayName: string;
  version: string | null;
  lastPublishedVersion: string | null;
  status: PublishStatus;
}

export interface PublishPlan {
  items: PublishPlanItem[];
  circular: string[] | null;
}

// --- Pure functions ---

export function computePublishStatus(node: GraphNode): PublishStatus {
  const { version, lastPublishedVersion } = node;
  if (!version || !isValidVersion(version)) return "no_version";
  if (!lastPublishedVersion) return "unpublished";
  if (version !== lastPublishedVersion) return "outdated";
  return "published";
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
        name: packages.name,
        manifest: packages.manifest,
        lastPublishedVersion: packages.lastPublishedVersion,
        source: packages.source,
      })
      .from(packages)
      .where(and(eq(packages.id, packageId), eq(packages.orgId, orgId)))
      .limit(1);

    if (!pkg) continue;
    if (pkg.source === "built-in") continue;

    const manifest = (pkg.manifest ?? {}) as Record<string, unknown>;
    const displayName =
      (manifest.displayName as string) || (manifest.name as string) || pkg.name || packageId;
    const version = manifest.version as string | null;

    nodes.set(packageId, {
      packageId,
      type: pkg.type,
      displayName,
      version,
      lastPublishedVersion: pkg.lastPublishedVersion,
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
      lastPublishedVersion: node.lastPublishedVersion,
      status: computePublishStatus(node),
    };
  });

  return { items, circular: null };
}
