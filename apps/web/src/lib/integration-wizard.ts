// SPDX-License-Identifier: Apache-2.0

// The guided addition of an integration from an MCP server URL. Nothing of the wizard is stored:
// its step is read from the package.

import {
  getDeclaredToolNames,
  readDefaultTools,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import { bumpVersion, compareVersionsDesc, isValidVersion } from "@appstrate/core/semver";
import { getSource } from "../components/integration-editor/utils";
import { ApiError } from "../api/errors";
import type { paths } from "../api/schema";
import {
  INTEGRATION_DOC,
  isToolsTruncated,
  mergeServerSync,
  type ServerSyncProposal,
} from "./integration-server-sync";
import { fileTextOperation, packageUpdateBody } from "./package-file-drafts";

export type DiscoveryResult =
  paths["/api/integrations/discover"]["post"]["responses"][200]["content"]["application/json"];
type DiscoveredManifest = DiscoveryResult["manifest"];

/** Whether a field of the proposal was read from the server or inferred. */
export type Provenance = "detected" | "guessed";

export interface WizardEdits {
  display_name: string;
  name: string;
}

export function proposalEdits(manifest: DiscoveredManifest): WizardEdits {
  return { display_name: manifest.display_name, name: manifest.name };
}

/** The proposal's `auths` replace the defaults' API key auth; none (AFPS §7.2) drops it. */
export function integrationCreationManifest(
  defaults: Record<string, unknown>,
  proposal: DiscoveredManifest,
  edits: WizardEdits,
  icon?: string,
): Record<string, unknown> {
  const { auths: _defaultAuths, ...base } = defaults;
  return {
    ...(proposal.auths === undefined ? base : defaults),
    ...proposal,
    display_name: edits.display_name.trim(),
    name: edits.name.trim(),
    ...(icon ? { icon } : {}),
  };
}

export type WizardAuthKind = "oauthAuto" | "oauthAdmin" | "apiKey" | "other";

export function wizardAuthKind(auth: unknown): WizardAuthKind {
  const { type, token_endpoint_auth_method } = (auth ?? {}) as Record<string, unknown>;
  if (type === "api_key") return "apiKey";
  if (type !== "oauth2") return "other";
  // A public client is registered at connect time (RFC 7591); any other needs a registered one.
  return token_endpoint_auth_method === "none" ? "oauthAuto" : "oauthAdmin";
}

export function declaredToolNames(manifest: Record<string, unknown>): string[] {
  return getDeclaredToolNames(manifest as IntegrationManifest);
}

/** How many declared tools an agent inherits when it selects none itself. */
export function defaultToolCount(manifest: Record<string, unknown>): number {
  const defaults = readDefaultTools(manifest as IntegrationManifest);
  if (defaults === "*") return declaredToolNames(manifest).length;
  return defaults?.length ?? 0;
}

export type IntegrationWizardStep = "notRemote" | "inactive" | "connect" | "tools" | "ready";

export type ProxyConnectionStatus =
  paths["/api/integrations/{packageId}"]["get"]["responses"][200]["content"]["application/json"]["proxy_connection"]["status"];

/** `must_choose` gets its choice at the tools step; `not_required` (AFPS §7.2) has nothing to connect. */
function connectionProceeds(status: ProxyConnectionStatus): boolean {
  return status === "ready" || status === "must_choose" || status === "not_required";
}

/** Why the connect step cannot move on, and whether connecting an account of one's own helps. */
export type ConnectBlocker =
  | "none"
  | "reconnect"
  | "reconnectImposed"
  | "notPermitted"
  | "notPermittedImposed"
  | "defaultUnavailable"
  | "unusable"
  | "unusableImposed";

/**
 * Connecting is offered only where a connection of the caller's own can change the verdict: never
 * under an imposed connection, past an org default that binds first, or without the permission.
 */
export function connectBlocker(verdict: { status: ProxyConnectionStatus; imposed: boolean }): {
  blocker: ConnectBlocker;
  offerConnect: boolean;
} {
  switch (verdict.status) {
    case "needs_reconnection":
      return verdict.imposed
        ? { blocker: "reconnectImposed", offerConnect: false }
        : { blocker: "reconnect", offerConnect: true };
    case "unusable":
      return verdict.imposed
        ? { blocker: "unusableImposed", offerConnect: false }
        : { blocker: "unusable", offerConnect: true };
    case "not_permitted":
      return {
        blocker: verdict.imposed ? "notPermittedImposed" : "notPermitted",
        offerConnect: false,
      };
    case "default_unavailable":
      return { blocker: "defaultUnavailable", offerConnect: false };
    default:
      return { blocker: "none", offerConnect: true };
  }
}

interface IntegrationWizardFacts {
  remote: boolean;
  active: boolean;
  published: boolean;
  connection: ProxyConnectionStatus;
  /** The manifest the detail reads (the published version, else the draft) declares tools. */
  toolsDeclared: boolean;
}

/**
 * Ready only once a PUBLISHED version declares tools: a draft declaring them before the first
 * publish (a save whose publish failed) is still at the tools step.
 */
export function integrationWizardStep(facts: IntegrationWizardFacts): IntegrationWizardStep {
  if (!facts.remote) return "notRemote";
  if (!facts.active) return "inactive";
  if (!connectionProceeds(facts.connection)) return "connect";
  return facts.published && facts.toolsDeclared ? "ready" : "tools";
}

export function isRemoteSource(manifest: Record<string, unknown>): boolean {
  return getSource(manifest).kind === "remote";
}

/** A remote server declaring no tool, for a caller who may write its home and open the wizard. */
export function needsWizardFinish(facts: {
  manifest: Record<string, unknown>;
  homeWritable: boolean;
  canOpenWizard: boolean;
}): boolean {
  return (
    facts.homeWritable &&
    facts.canOpenWizard &&
    isRemoteSource(facts.manifest) &&
    declaredToolNames(facts.manifest).length === 0
  );
}

export function wizardResumePath(packageId: string): string {
  return `/integrations/new/mcp?${new URLSearchParams({ package: packageId })}`;
}

/** The draft's own version until a publish, then the next minor — never below the draft's. */
export function toolsPublishVersion(facts: {
  published: boolean;
  publishedVersion: unknown;
  draftVersion: unknown;
}): string | null {
  const draft =
    typeof facts.draftVersion === "string" && isValidVersion(facts.draftVersion)
      ? facts.draftVersion
      : null;
  if (!facts.published) return draft;
  const next =
    typeof facts.publishedVersion === "string"
      ? bumpVersion(facts.publishedVersion, "minor")
      : null;
  if (!next) return null;
  return draft && compareVersionsDesc(draft, next) < 0 ? draft : next;
}

/** A JSON value with its object keys sorted: two equal values give one string. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}

/** Whether the draft's `auths` are the published version's, key order aside. */
export function sameAuths(draft: Record<string, unknown>, published: Record<string, unknown>) {
  return canonicalJson(draft.auths ?? null) === canonicalJson(published.auths ?? null);
}

/**
 * What a sync refused for want of an account calls for. The sync reads the DRAFT's auths, while
 * connecting reaches the PUBLISHED ones once a version exists: when the draft changes them
 * (`unpublishedAuths`), no connect can clear the refusal.
 */
export function syncConnectionRemedy(
  error: unknown,
  facts: { published: boolean; authsMatch: boolean },
): "connect" | "unpublishedAuths" | null {
  if (
    !(error instanceof ApiError) ||
    (error.code !== "integration_not_connected" && error.code !== "needs_reconnection")
  ) {
    return null;
  }
  return !facts.published || facts.authsMatch ? "connect" : "unpublishedAuths";
}

/** The wizard publishes the draft with its tools; the manual way creates as every dialog does. */
export function wizardCreateBody(manifest: Record<string, unknown>, way: "guided" | "manual") {
  return way === "guided" ? { manifest, publish: false as const } : { manifest };
}

/** A change to the source or the auths a catalogue read went through is another read. */
export function catalogSourceKey(draft: Record<string, unknown>): string {
  const source = getSource(draft);
  return JSON.stringify([
    source.kind,
    source.remoteUrl,
    source.remoteTransport,
    canonicalJson(draft.auths ?? null),
  ]);
}

/** A connection added or reconnected since a read is a reason to read the server again. */
export function catalogConnectionsKey(detail: {
  auths: readonly { connections: readonly { id: string; needs_reconnection: boolean }[] }[];
}): string {
  return JSON.stringify(
    detail.auths
      .flatMap((auth) => auth.connections.map((c) => `${c.id}:${c.needs_reconnection}`))
      .sort(),
  );
}

/**
 * The draft's own `default_tools` once it declares tools (an explicit `[]` included), restricted
 * to the listed tools; otherwise the server's read-only pre-selection.
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
  const destructive = new Set(proposal.tools.filter((tool) => tool.destructive).map((t) => t.name));
  return new Set(proposal.manifest.default_tools.filter((name) => !destructive.has(name)));
}

/**
 * A documentation the wizard did not write is never touched: the file is deleted only when THIS
 * session wrote it and the user has since declined it. `written` is the next save's input.
 */
export function docsChoice(state: {
  include: boolean;
  instructions: string | null;
  written: boolean;
}): { instructions: string | null; removeDocs: boolean; written: boolean } {
  const instructions = state.include ? state.instructions : null;
  if (instructions) return { instructions, removeDocs: false, written: true };
  const removeDocs = state.written && !state.include;
  return { instructions: null, removeDocs, written: state.written && !removeDocs };
}

/**
 * The user's choice among the listed tools. A truncated list leaves the draft's other declared
 * tools in `tools_policy`, so the selection keeps those of them it already held.
 */
function toolsSelection(
  merged: Record<string, unknown>,
  proposal: Pick<ServerSyncProposal, "manifest" | "warnings">,
  selected: readonly string[],
): string[] {
  if (!isToolsTruncated(proposal)) return [...selected];
  const listed = new Set(Object.keys(proposal.manifest.tools_policy));
  const declared = new Set(declaredToolNames(merged));
  const held: unknown[] =
    merged.default_tools === "*"
      ? [...declared]
      : Array.isArray(merged.default_tools)
        ? merged.default_tools
        : [];
  const kept = held.filter(
    (name): name is string => typeof name === "string" && !listed.has(name) && declared.has(name),
  );
  return [...kept, ...selected.filter((name) => declared.has(name))];
}

/** The draft save declaring the server's tools, their selection, the version and the docs. */
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
  const merged = mergeServerSync(draft, proposal);
  return packageUpdateBody({
    manifest: {
      ...merged,
      default_tools: toolsSelection(merged, proposal, choice.selected),
      version: choice.version,
    },
    operations: choice.instructions
      ? [fileTextOperation(INTEGRATION_DOC, choice.instructions)]
      : choice.removeDocs
        ? [{ op: "delete", path: INTEGRATION_DOC }]
        : undefined,
  });
}
