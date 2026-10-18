// SPDX-License-Identifier: Apache-2.0

// The guided addition of an integration from an MCP server URL: the manifests it writes, the
// manifest it hands to the manual editor, and the step a package is at. Nothing of the wizard is
// stored: its step is read from the package.

import {
  getDeclaredToolNames,
  readDefaultTools,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import { bumpVersion } from "@appstrate/core/semver";
import { getSource } from "../components/integration-editor/utils";
import type { paths } from "../api/schema";
import { mergeServerSync, type ServerSyncProposal } from "./integration-server-sync";
import { fileTextOperation, packageUpdateBody } from "./package-file-drafts";

export type DiscoveryResult =
  paths["/api/integrations/discover"]["post"]["responses"][200]["content"]["application/json"];
type DiscoveredManifest = DiscoveryResult["manifest"];

/** What the review lets the user change before creating. */
export interface WizardEdits {
  display_name: string;
  name: string;
}

export function proposalEdits(manifest: DiscoveredManifest): WizardEdits {
  return { display_name: manifest.display_name, name: manifest.name };
}

/**
 * The manifest the wizard creates (or hands to the manual editor): the editor's defaults, the
 * proposal over them — its `auths` replace the default API key auth, they are not merged — then
 * the user's edits and the icon.
 */
export function integrationCreationManifest(
  defaults: Record<string, unknown>,
  proposal: DiscoveredManifest,
  edits: WizardEdits,
  icon?: string,
): Record<string, unknown> {
  return {
    ...defaults,
    ...proposal,
    display_name: edits.display_name.trim(),
    name: edits.name.trim(),
    ...(icon ? { icon } : {}),
  };
}

/** How the user connects an account, in the review's words. */
export type WizardAuthKind = "oauthAuto" | "oauthAdmin" | "apiKey" | "other";

export function wizardAuthKind(auth: unknown): WizardAuthKind {
  const { type, token_endpoint_auth_method } = (auth ?? {}) as Record<string, unknown>;
  if (type === "api_key") return "apiKey";
  if (type !== "oauth2") return "other";
  // A public client is registered at connect time (RFC 7591); any other needs a registered one.
  return token_endpoint_auth_method === "none" ? "oauthAuto" : "oauthAdmin";
}

/** Router state carrying the accepted manifest to the manual creation page. */
export function manualCreationState(manifest: Record<string, unknown>) {
  return { integrationManifest: manifest };
}

export function readManualCreationManifest(state: unknown): Record<string, unknown> | undefined {
  if (!state || typeof state !== "object" || !("integrationManifest" in state)) return undefined;
  const manifest = (state as { integrationManifest?: unknown }).integrationManifest;
  return manifest && typeof manifest === "object" && !Array.isArray(manifest)
    ? (manifest as Record<string, unknown>)
    : undefined;
}

/** For a remote source the declared catalog is `tools_policy`'s keys (`getDeclaredToolNames`). */
export function declaredToolNames(manifest: Record<string, unknown>): string[] {
  return getDeclaredToolNames(manifest as IntegrationManifest);
}

/** How many declared tools an agent inherits when it selects none itself. */
export function defaultToolCount(manifest: Record<string, unknown>): number {
  const defaults = readDefaultTools(manifest as IntegrationManifest);
  if (defaults === "*") return declaredToolNames(manifest).length;
  return defaults?.length ?? 0;
}

export type IntegrationWizardStep = "unpublished" | "connect" | "tools" | "ready";

interface IntegrationWizardFacts {
  /** The package has a published version. */
  published: boolean;
  /** The caller holds a connection that is not flagged for reconnection. */
  connected: boolean;
  /** The published version declares tools. */
  toolsDeclared: boolean;
}

/** Where an integration being added stands, read from the package alone. */
export function integrationWizardStep(facts: IntegrationWizardFacts): IntegrationWizardStep {
  if (!facts.published) return "unpublished";
  if (facts.toolsDeclared) return "ready";
  return facts.connected ? "tools" : "connect";
}

/** Whether the integration page offers to resume the wizard: a published remote server with no tool declared, which the caller may write. */
export function needsWizardFinish(facts: {
  manifest: Record<string, unknown>;
  published: boolean;
  writable: boolean;
}): boolean {
  return (
    facts.published &&
    facts.writable &&
    getSource(facts.manifest).kind === "remote" &&
    declaredToolNames(facts.manifest).length === 0
  );
}

/** The wizard's resume address for a package. */
export function wizardResumePath(packageId: string): string {
  return `/integrations/new/mcp?${new URLSearchParams({ package: packageId })}`;
}

/** The version the tools are published as: the next minor of the published one. */
export function nextMinorVersion(version: unknown): string | null {
  return typeof version === "string" ? bumpVersion(version, "minor") : null;
}

/**
 * The draft save that declares the server's tools: the sync merged into the draft, the selection
 * as `default_tools`, the new version, and the server's instructions as `INTEGRATION.md` when
 * accepted.
 */
export function toolsUpdateBody(
  draft: Record<string, unknown>,
  proposal: Pick<ServerSyncProposal, "manifest" | "warnings">,
  choice: { selected: readonly string[]; version: string; instructions: string | null },
) {
  return packageUpdateBody({
    manifest: {
      ...mergeServerSync(draft, proposal),
      default_tools: [...choice.selected],
      version: choice.version,
    },
    operations: choice.instructions
      ? [fileTextOperation("INTEGRATION.md", choice.instructions)]
      : undefined,
  });
}
