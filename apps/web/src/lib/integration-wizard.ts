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
import { fileTextOperation, packageCreateBody, packageUpdateBody } from "./package-file-drafts";

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

export type IntegrationWizardStep = "notRemote" | "connect" | "tools" | "ready";

interface IntegrationWizardFacts {
  /** The integration is served by a remote MCP server, the only source this wizard handles. */
  remote: boolean;
  /** The package has a published version. */
  published: boolean;
  /**
   * A connection the caller can use here, its own or one shared into the space, is not flagged for
   * reconnection (`auth.ready`).
   */
  connected: boolean;
  /** The manifest the detail reads declares tools: the published version, else the draft. */
  toolsDeclared: boolean;
}

/**
 * Where an integration being added stands, read from the package alone. Ready only once a
 * published version declares tools: before the first publish, a draft that already declares them
 * (a save whose publish failed) is still at the tools step.
 */
export function integrationWizardStep(facts: IntegrationWizardFacts): IntegrationWizardStep {
  if (!facts.remote) return "notRemote";
  if (!facts.connected) return "connect";
  return facts.published && facts.toolsDeclared ? "ready" : "tools";
}

export function isRemoteSource(manifest: Record<string, unknown>): boolean {
  return getSource(manifest).kind === "remote";
}

/** An analysis answers the input only while the input still holds the address it was asked for. */
export function isCurrentAnalysis(latestInput: string, requested: string): boolean {
  return latestInput.trim() === requested;
}

/**
 * Whether the integration page offers to resume the wizard: a remote server the caller may write
 * whose manifest declares no tool — the published version's, or the draft's while nothing is
 * published.
 */
export function needsWizardFinish(facts: {
  manifest: Record<string, unknown>;
  writable: boolean;
}): boolean {
  return (
    facts.writable &&
    isRemoteSource(facts.manifest) &&
    declaredToolNames(facts.manifest).length === 0
  );
}

/** The wizard's resume address for a package. */
export function wizardResumePath(packageId: string): string {
  return `/integrations/new/mcp?${new URLSearchParams({ package: packageId })}`;
}

/**
 * The version the tools are published as: the draft's own (its first version, `1.0.0` from the
 * wizard) while nothing is published, else the next minor of the published one.
 */
export function toolsPublishVersion(facts: {
  published: boolean;
  publishedVersion: unknown;
  draftVersion: unknown;
}): string | null {
  if (!facts.published) return typeof facts.draftVersion === "string" ? facts.draftVersion : null;
  return typeof facts.publishedVersion === "string"
    ? bumpVersion(facts.publishedVersion, "minor")
    : null;
}

/** The create body of the wizard: the draft alone, activated here, published with its tools. */
export function wizardCreateBody(manifest: Record<string, unknown>) {
  return { ...packageCreateBody({ manifest }, "integration"), publish: false as const };
}

/**
 * The tools checked when the step opens: the draft's own `default_tools` once it declares tools
 * (a save of this step, an explicit `[]` included), restricted to the tools the server lists;
 * otherwise the server's read-only pre-selection.
 */
export function initialToolSelection(
  draft: Record<string, unknown>,
  proposal: Pick<ServerSyncProposal, "manifest" | "tools">,
): Set<string> {
  const listed = proposal.tools.map((tool) => tool.name);
  const saved =
    declaredToolNames(draft).length > 0
      ? readDefaultTools(draft as IntegrationManifest)
      : undefined;
  if (saved === "*") return new Set(listed);
  if (Array.isArray(saved)) return new Set(listed.filter((name) => saved.includes(name)));
  return new Set(proposal.manifest.default_tools);
}

const INTEGRATION_DOC = "INTEGRATION.md";

/**
 * What a save does with `INTEGRATION.md`: write the server's instructions when accepted, delete
 * the file only when THIS session wrote it and the user has since declined it, else nothing — a
 * documentation the wizard did not write is never touched. `written` is the next save's input.
 */
export function docsChoice(state: {
  include: boolean;
  instructions: string | null;
  /** This session's last save wrote the file. */
  written: boolean;
}): { instructions: string | null; removeDocs: boolean; written: boolean } {
  const instructions = state.include ? state.instructions : null;
  if (instructions) return { instructions, removeDocs: false, written: true };
  const removeDocs = state.written && !state.include;
  return { instructions: null, removeDocs, written: state.written && !removeDocs };
}

/**
 * The draft save that declares the server's tools: the sync merged into the draft, the selection
 * as `default_tools`, the version to publish, and `INTEGRATION.md` as {@link docsChoice} decides.
 */
export function toolsUpdateBody(
  draft: Record<string, unknown>,
  proposal: Pick<ServerSyncProposal, "manifest" | "warnings">,
  choice: {
    selected: readonly string[];
    version: string;
    instructions: string | null;
    removeDocs?: boolean;
  },
) {
  return packageUpdateBody({
    manifest: {
      ...mergeServerSync(draft, proposal),
      default_tools: [...choice.selected],
      version: choice.version,
    },
    operations: choice.instructions
      ? [fileTextOperation(INTEGRATION_DOC, choice.instructions)]
      : choice.removeDocs
        ? [{ op: "delete", path: INTEGRATION_DOC }]
        : undefined,
  });
}
