// SPDX-License-Identifier: Apache-2.0

/**
 * Default-tool conformance for the shipped system packages.
 *
 * `default_tools` is what an agent inherits when it declares an integration
 * with no `integrations_configuration.<id>.tools`. An integration with a
 * callable surface and no usable default hands that agent zero tools: the run
 * aborts at boot, with nothing pointing back at the integration manifest.
 *
 * Three invariants, judged offline with the platform's own resolvers: the
 * default is named and non-empty, each default is a tool the integration
 * exposes, and each is within the auth's default scopes. A default may name
 * fewer tools than the integration exposes.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { join } from "node:path";
import {
  loadSystemPackages,
  type LoadSystemPackagesResult,
  type SystemPackageEntry,
} from "@appstrate/core/system-packages";
import { isToolsWildcard } from "@appstrate/core/dependencies";
import {
  resolveEffectiveToolSelection,
  resolveIntegrationToolCatalog,
  scopesNotCovered,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import { getLocalServerRef } from "../../../src/services/integration-manifest-helpers.ts";

const ARCHIVE_DIR = join(import.meta.dir, "../../../../../system-packages");

interface Pkg {
  packageId: string;
  sourceKind: string | undefined;
  manifest: IntegrationManifest;
  /** Resolved tool names: `hidden_tools` subtracted, `api_call` / `api_upload` appended. */
  catalog: Set<string>;
  missingServer?: string;
}

function mcpServerToolsOf(server: SystemPackageEntry): Array<{ name: string }> | undefined {
  const tools = (server.manifest as { tools?: Array<{ name?: unknown }> }).tools;
  if (!Array.isArray(tools)) return undefined;
  return tools.flatMap((t) => (typeof t?.name === "string" ? [{ name: t.name }] : []));
}

/** Integrations an agent can call: a `remote` or `local` source, or a non-empty catalog. */
function callableIntegrations(packages: SystemPackageEntry[]): Pkg[] {
  const mcpServers = new Map(
    packages.filter((p) => p.type === "mcp-server").map((p) => [p.packageId, p]),
  );
  const callable: Pkg[] = [];
  for (const entry of packages) {
    if (entry.type !== "integration") continue;
    const manifest = entry.manifest as unknown as IntegrationManifest;
    const sourceKind = (entry.manifest.source as { kind?: string } | undefined)?.kind;
    const serverRef = getLocalServerRef(manifest);
    const server = serverRef ? mcpServers.get(serverRef.name) : undefined;
    const catalog = resolveIntegrationToolCatalog({
      integration: manifest,
      mcpServerTools: server ? mcpServerToolsOf(server) : undefined,
    }).map((tool) => tool.name);
    if (sourceKind !== "remote" && sourceKind !== "local" && catalog.length === 0) continue;
    callable.push({
      packageId: entry.packageId,
      sourceKind,
      manifest,
      catalog: new Set(catalog),
      ...(sourceKind === "local" && !server
        ? { missingServer: serverRef?.name ?? "(no source.server)" }
        : {}),
    });
  }
  return callable.sort((a, b) => a.packageId.localeCompare(b.packageId));
}

function namedDefaults(manifest: IntegrationManifest): readonly string[] {
  const selection = resolveEffectiveToolSelection(undefined, manifest);
  return selection === undefined || isToolsWildcard(selection) ? [] : selection;
}

describe("system-package default_tools", () => {
  let archive: LoadSystemPackagesResult;
  let callable: Pkg[];

  beforeAll(async () => {
    archive = await loadSystemPackages(ARCHIVE_DIR);
    callable = callableIntegrations(archive.packages);
  });

  // An unreadable directory loads as an empty set, and a filter that drops a
  // source kind only shortens the loops below: both would pass over nothing.
  it("reads the archives and judges every source kind", () => {
    expect(archive.warnings).toEqual([]);
    expect(archive.packages.length).toBeGreaterThan(0);
    expect(callable.length).toBeGreaterThan(0);
    expect([...new Set(callable.map((p) => p.sourceKind))]).toEqual(
      expect.arrayContaining(["remote", "local", "none"]),
    );
  });

  // Without it the catalog falls back to `tools_policy` keys, not the server's tools.
  it("ships the mcp-server every local integration references", () => {
    const missing = callable
      .filter((p) => p.missingServer !== undefined)
      .map((p) => `${p.packageId}: mcp-server ${p.missingServer} is not a shipped system package`);
    expect(missing).toEqual([]);
  });

  // A wildcard is refused: it inherits every tool the upstream adds later.
  it("gives every callable integration a named, non-empty default", () => {
    const offenders: string[] = [];
    for (const pkg of callable) {
      const selection = resolveEffectiveToolSelection(undefined, pkg.manifest);
      if (selection === undefined) {
        offenders.push(`${pkg.packageId} (${pkg.sourceKind}): no default_tools`);
      } else if (isToolsWildcard(selection)) {
        offenders.push(`${pkg.packageId} (${pkg.sourceKind}): default_tools is the "*" wildcard`);
      } else if (selection.length === 0) {
        offenders.push(`${pkg.packageId} (${pkg.sourceKind}): default_tools is empty`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // A default renamed upstream, or hidden by the same manifest, registers nothing at boot.
  it("names only tools the integration exposes", () => {
    const offenders: string[] = [];
    for (const pkg of callable) {
      const unknown = namedDefaults(pkg.manifest).filter((tool) => !pkg.catalog.has(tool));
      if (unknown.length > 0) {
        offenders.push(`${pkg.packageId}: not in the tool catalog: ${unknown.join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Readiness infers scopes from the agent's own selection, never from inherited
  // defaults, so a default outside `default_scopes` fails upstream at call time.
  it("keeps every default tool within the auth's default scopes", () => {
    const offenders: string[] = [];
    let judged = 0;
    for (const pkg of callable) {
      for (const tool of namedDefaults(pkg.manifest)) {
        const required = pkg.manifest.tools_policy?.[tool]?.required_scopes;
        if (!required) continue;
        for (const [authKey, scopes] of Object.entries(required)) {
          judged++;
          const uncovered = scopesNotCovered(
            scopes,
            pkg.manifest.auths?.[authKey]?.default_scopes ?? [],
            pkg.manifest,
            authKey,
          );
          if (uncovered.length > 0) {
            offenders.push(
              `${pkg.packageId}: ${tool} needs ${uncovered.join(", ")} outside auths.${authKey}.default_scopes`,
            );
          }
        }
      }
    }
    expect(judged).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
