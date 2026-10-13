// SPDX-License-Identifier: Apache-2.0

/**
 * Default-tool conformance for the shipped system packages.
 *
 * `default_tools` is what an agent inherits when it declares an integration
 * with no `integrations_configuration.<id>.tools`. Its failure mode sits far
 * from its cause: an integration with a callable surface and no usable default
 * hands such an agent zero tools, and the run aborts at boot — on the agent,
 * with nothing pointing back at the integration manifest. A default naming a
 * tool the integration does not expose, or one the auth's default scopes do
 * not cover, is just as quiet: the manifest validates, the connection reads as
 * ready, and the call fails upstream.
 *
 * Whether the upstream still serves a named tool is NOT asserted here — that
 * needs the network and belongs to the conformance monitor. What is pinned is
 * everything checkable offline, through the functions the platform itself
 * resolves a selection with: that every shipped integration an agent can call
 * HAS a named default, that each default is in the integration's own catalog,
 * and that the auth's default scopes cover it.
 */

import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { loadSystemPackages, type SystemPackageEntry } from "@appstrate/core/system-packages";
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
  /** Tool names the integration exposes — what the picker and `tools/list` see. */
  catalog: Set<string>;
  /** The mcp-server a `local` source references, when it is not a shipped package. */
  missingServer?: string;
}

/** MCPB `tools[]` of a shipped mcp-server, the base catalog of a `local` source. */
function mcpServerToolsOf(server: SystemPackageEntry): Array<{ name: string }> | undefined {
  const tools = (server.manifest as { tools?: Array<{ name?: unknown }> }).tools;
  if (!Array.isArray(tools)) return undefined;
  return tools.flatMap((t) => (typeof t?.name === "string" ? [{ name: t.name }] : []));
}

/**
 * Every shipped integration with a callable surface: a `remote` or `local`
 * source, or a non-empty catalog — which is how a `none` source exposing
 * `api_call` qualifies. A `none` source with an empty catalog has nothing to
 * inherit and is left out.
 */
async function loadCallable(): Promise<Pkg[]> {
  const { packages, warnings } = await loadSystemPackages(ARCHIVE_DIR);
  expect(warnings).toEqual([]);
  // `loadSystemPackages` swallows a `readdir` failure and returns an empty
  // set, and ARCHIVE_DIR is a five-level relative climb — so a moved test
  // file or a renamed directory would leave every assertion below comparing
  // `[]` to `[]` and reporting success over zero packages. Anchor the whole
  // file on the archive actually having been read.
  expect(packages.length).toBeGreaterThan(0);

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

  // The filter above is the second way this file could pass over nothing: a
  // `source` shape it stops recognising drops a whole kind and every loop
  // below simply runs shorter. Each kind resolves its catalog differently, so
  // all three must be present.
  expect(callable.length).toBeGreaterThan(0);
  expect(callable.map((p) => p.sourceKind)).toEqual(
    expect.arrayContaining(["remote", "local", "none"]),
  );
  return callable.sort((a, b) => a.packageId.localeCompare(b.packageId));
}

/** The named tools an agent inherits, or `[]` for an absent or wildcard default. */
function namedDefaults(manifest: IntegrationManifest): readonly string[] {
  const selection = resolveEffectiveToolSelection(undefined, manifest);
  return selection === undefined || isToolsWildcard(selection) ? [] : selection;
}

describe("system-package default_tools", () => {
  // Without the referenced mcp-server the catalog falls back to the sparse
  // `tools_policy` keys, and the membership check below would judge the
  // defaults against a list that is not the integration's surface.
  it("ships the mcp-server every local integration references", async () => {
    const missing = (await loadCallable())
      .filter((p) => p.missingServer !== undefined)
      .map((p) => `${p.packageId}: mcp-server ${p.missingServer} is not a shipped system package`);
    expect(missing).toEqual([]);
  });

  // A wildcard counts as no default here: it inherits every tool the upstream
  // adds later, unreviewed. Shipped integrations name what an agent inherits.
  it("gives every callable integration a named, non-empty default", async () => {
    const offenders: string[] = [];
    for (const pkg of await loadCallable()) {
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

  // The catalog is the resolved one: `hidden_tools` subtracted, the synthetic
  // `api_call` / `api_upload` names appended. A default outside it — renamed
  // upstream, or hidden by the same manifest — registers nothing at boot.
  it("names only tools the integration exposes", async () => {
    const offenders: string[] = [];
    for (const pkg of await loadCallable()) {
      const unknown = namedDefaults(pkg.manifest).filter((tool) => !pkg.catalog.has(tool));
      if (unknown.length > 0) {
        offenders.push(`${pkg.packageId}: not in the tool catalog: ${unknown.join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Scope inference reads the agent's own selection, never the inherited
  // defaults (`requirementOf`, services/integration-connection-resolver.ts), so
  // readiness asks a connection for nothing on behalf of an inherited tool. One
  // that needs a scope outside the auth's `default_scopes` passes readiness and
  // fails upstream at call time.
  it("keeps every default tool within the auth's default scopes", async () => {
    const offenders: string[] = [];
    for (const pkg of await loadCallable()) {
      for (const tool of namedDefaults(pkg.manifest)) {
        const required = pkg.manifest.tools_policy?.[tool]?.required_scopes;
        if (!required) continue;
        for (const [authKey, scopes] of Object.entries(required)) {
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
    expect(offenders).toEqual([]);
  });
});
