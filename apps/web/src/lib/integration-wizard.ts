// SPDX-License-Identifier: Apache-2.0

// The guided addition of an integration from an MCP server URL: the manifests it writes, the
// manifest it hands to the manual editor, and the step a package is at. Nothing of the wizard is
// stored: its step is read from the package.

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
  isToolsTruncated,
  mergeServerSync,
  type ServerSyncProposal,
} from "./integration-server-sync";
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

export type IntegrationWizardStep = "notRemote" | "inactive" | "connect" | "tools" | "ready";

/** What a credential-proxy call outside a run would bind for the caller here (the detail's verdict). */
export type ProxyConnectionStatus =
  paths["/api/integrations/{packageId}"]["get"]["responses"][200]["content"]["application/json"]["proxy_connection"]["status"];

/** The governed verdicts the tools step proceeds on: `must_choose` gets its choice there. */
function connectionProceeds(status: ProxyConnectionStatus): boolean {
  return status === "ready" || status === "must_choose";
}

/** Why the connect step cannot move on, and whether connecting an account of one's own helps. */
export type ConnectBlocker =
  | "none"
  | "reconnect"
  | "reconnectImposed"
  | "notPermitted"
  | "defaultUnavailable"
  | "unusable"
  | "unusableImposed";

/**
 * The connect step's reading of the verdict. Connecting is offered only where a connection of the
 * caller's own can change it: never under an imposed connection, nor past an org default that
 * binds before any personal connection, nor without the proxy permission it lacks.
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
      return { blocker: "notPermitted", offerConnect: false };
    case "default_unavailable":
      return { blocker: "defaultUnavailable", offerConnect: false };
    default:
      return { blocker: "none", offerConnect: true };
  }
}

interface IntegrationWizardFacts {
  /** The integration is served by a remote MCP server, the only source this wizard handles. */
  remote: boolean;
  /** The integration is switched on in this space (the detail's `active`): no call reaches it else. */
  active: boolean;
  /** The package has a published version. */
  published: boolean;
  /** `proxy_connection.status`: the space's governance applied, for this caller. */
  connection: ProxyConnectionStatus;
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
  if (!facts.active) return "inactive";
  if (!connectionProceeds(facts.connection)) return "connect";
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
 * Whether the integration page offers to resume the wizard: a remote server whose manifest
 * declares no tool — the published version's, or the draft's while nothing is published — for a
 * caller who may both write the package's home and open the wizard's route in this space.
 */
export function needsWizardFinish(facts: {
  manifest: Record<string, unknown>;
  /** `home_writable`: the save and the publish are writes in the package's home. */
  homeWritable: boolean;
  /** The wizard's route is reachable in the CURRENT space (`integrations:write` here). */
  canOpenWizard: boolean;
}): boolean {
  return (
    facts.homeWritable &&
    facts.canOpenWizard &&
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
  const draft =
    typeof facts.draftVersion === "string" && isValidVersion(facts.draftVersion)
      ? facts.draftVersion
      : null;
  if (!facts.published) return draft;
  const next =
    typeof facts.publishedVersion === "string"
      ? bumpVersion(facts.publishedVersion, "minor")
      : null;
  // Never below the draft's own version: a draft already set past the next minor keeps it.
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

/**
 * Whether the draft holds changes the tools step's publish would ship that the wizard does not
 * write and that change what is called: its `source` or its `auths`. The identity, the tools,
 * the version and `INTEGRATION.md` are the wizard's own (a reload after its failed publish
 * leaves them), and warn about nothing.
 */
export function draftChangesBeyondWizard(
  draft: Record<string, unknown>,
  published: Record<string, unknown>,
): boolean {
  return (["source", "auths"] as const).some(
    (key) => canonicalJson(draft[key] ?? null) !== canonicalJson(published[key] ?? null),
  );
}

/** A publish refused because the draft moved since its save (`412`): the next submit saves again. */
export function isStalePublish(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 412 || error.code === "precondition_failed")
  );
}

/**
 * A server sync that needs an account first — none in reach of the draft's auths
 * (`integration_not_connected`), or one to reconnect (`needs_reconnection`): the connect step,
 * not a dead error. A published integration whose draft changed auths lands here.
 */
export function syncNeedsConnection(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === "integration_not_connected" || error.code === "needs_reconnection")
  );
}

/** The create body of the wizard: the draft alone, activated here, published with its tools. */
export function wizardCreateBody(manifest: Record<string, unknown>) {
  return { ...packageCreateBody({ manifest }, "integration"), publish: false as const };
}

/**
 * What a read of the server's catalogue was read FROM: the draft's source and the auths the
 * proxy authorizes the call with. A change to either is another read, never a cached answer.
 */
export function catalogSourceKey(draft: Record<string, unknown>): string {
  const source = getSource(draft);
  const auths = Object.entries(
    (draft.auths && typeof draft.auths === "object" ? draft.auths : {}) as Record<string, unknown>,
  )
    .map(([key, auth]) => {
      const { type, authorized_uris } = (auth ?? {}) as Record<string, unknown>;
      return [key, type ?? null, authorized_uris ?? null] as const;
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([source.kind, source.remoteUrl, source.remoteTransport, auths]);
}

/**
 * The connections a read of the catalogue went through, as its cache key: one added or
 * reconnected since is a reason to read the server again.
 */
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
  // The server already leaves destructive tools out; a destructive hint is never pre-checked.
  const destructive = new Set(proposal.tools.filter((tool) => tool.destructive).map((t) => t.name));
  return new Set(proposal.manifest.default_tools.filter((name) => !destructive.has(name)));
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
 * The saved `default_tools`: the user's choice among the listed tools. A truncated list leaves the
 * draft's other declared tools in `tools_policy` ({@link mergeServerSync}), so the selection keeps
 * those of them it already held; a name the merged policy does not declare is never added.
 */
function toolsSelection(
  merged: Record<string, unknown>,
  proposal: Pick<ServerSyncProposal, "manifest" | "warnings">,
  selected: readonly string[],
): string[] {
  if (!isToolsTruncated(proposal)) return [...selected];
  const listed = new Set(Object.keys(proposal.manifest.tools_policy));
  const declared = new Set(declaredToolNames(merged));
  // `*` selected every declared tool, the unlisted ones included.
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
