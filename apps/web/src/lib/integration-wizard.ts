// SPDX-License-Identifier: Apache-2.0

// The guided addition of an integration from an MCP server URL. Nothing of the wizard is stored:
// its step is read from the package.

import { bumpVersion, compareVersionsDesc, isValidVersion } from "@appstrate/core/semver";
import { getSource, setAllowUndeclaredTools } from "../components/integration-editor/utils";
import type { paths } from "../api/schema";
import { fileTextOperation, packageUpdateBody } from "./package-file-drafts";
import { INTEGRATION_DOC, mergeServerIdentity } from "./integration-server-sync";

export type DiscoveryResult =
  paths["/api/integrations/discover"]["post"]["responses"][200]["content"]["application/json"];
type DiscoveredManifest = DiscoveryResult["manifest"];

/** Whether a field of the proposal was read from the server or inferred. */
export type Provenance = "detected" | "guessed";

export type WizardEdits = Pick<DiscoveredManifest, "display_name" | "name">;

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

export type IntegrationWizardStep = "notRemote" | "inactive" | "connect" | "tools" | "ready";

export type ProxyConnectionStatus =
  paths["/api/integrations/{packageId}"]["get"]["responses"][200]["content"]["application/json"]["proxy_connection"]["status"];

/**
 * `must_choose` gets its choice at the tools step; `not_required` (AFPS §7.2) has nothing to
 * connect. A never-published integration (`not_published`) hides the connection's own verdict,
 * which the proxy cannot judge before the first publish, so the step reads whether an account
 * exists; the tools step then publishes.
 */
function connectionProceeds(status: ProxyConnectionStatus, connected: boolean): boolean {
  if (status === "not_published") return connected;
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
  | "unusableImposed"
  | "proxyClosed";

/**
 * Connecting is offered only where a connection of the caller's own can change the verdict: never
 * under an imposed connection, past an org default that binds first, without the permission, or
 * in a space that closes the credential proxy outside a run.
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
    case "proxy_closed":
      return { blocker: "proxyClosed", offerConnect: false };
    default:
      return { blocker: "none", offerConnect: true };
  }
}

interface IntegrationWizardFacts {
  remote: boolean;
  active: boolean;
  published: boolean;
  connection: ProxyConnectionStatus;
  /** An account exists on some auth, or the integration declares none. */
  connected: boolean;
}

/** Ready once a version is published: the tools step is the publish. */
export function integrationWizardStep(facts: IntegrationWizardFacts): IntegrationWizardStep {
  if (!facts.remote) return "notRemote";
  if (!facts.active) return "inactive";
  if (!connectionProceeds(facts.connection, facts.connected)) return "connect";
  return facts.published ? "ready" : "tools";
}

export function isRemoteSource(manifest: Record<string, unknown>): boolean {
  return getSource(manifest).kind === "remote";
}

/** A remote integration whose first version is not published, for a caller who may finish it. */
export function needsWizardFinish(facts: {
  manifest: Record<string, unknown>;
  published: boolean;
  homeWritable: boolean;
  canOpenWizard: boolean;
}): boolean {
  return (
    facts.homeWritable && facts.canOpenWizard && !facts.published && isRemoteSource(facts.manifest)
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

/** The wizard publishes once its tools choice is made; the manual way creates as every dialog does. */
export function wizardCreateBody(manifest: Record<string, unknown>, way: "guided" | "manual") {
  return way === "guided" ? { manifest, publish: false as const } : { manifest };
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
 * The draft save before the publish: the version, the tools choice, the identity the server
 * proposes where the draft's is empty, and the server's instructions as `INTEGRATION.md`. Trusting
 * every tool declares `allow_undeclared_tools`; the default declares nothing, so each tool the
 * server lists is reviewed in each space before an agent runs it. Declaring a tool trusts it by
 * name for good, which is why the wizard declares none.
 */
export function toolsPublishBody(
  draft: Record<string, unknown>,
  choice: {
    trustAll: boolean;
    version: string;
    /** The identity read's manifest; absent when it could not be read. */
    proposed?: Record<string, unknown>;
    instructions?: string | null;
    removeDocs?: boolean;
  },
) {
  const identified = choice.proposed ? mergeServerIdentity(draft, choice.proposed).manifest : draft;
  return packageUpdateBody({
    manifest: { ...setAllowUndeclaredTools(identified, choice.trustAll), version: choice.version },
    operations: choice.instructions
      ? [fileTextOperation(INTEGRATION_DOC, choice.instructions)]
      : choice.removeDocs
        ? [{ op: "delete", path: INTEGRATION_DOC }]
        : undefined,
  });
}
