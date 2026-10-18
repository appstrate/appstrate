// SPDX-License-Identifier: Apache-2.0

import {
  resolveIntegrationToolCatalog,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import { ApiError } from "../api/errors";
import type { components, paths } from "../api/schema";
import { getSource, setSource } from "../components/integration-editor/utils";

export type DiscoveryProposal =
  paths["/api/integrations/discover"]["post"]["responses"][200]["content"]["application/json"];

export type ServerSyncProposal =
  paths["/api/integrations/{packageId}/discover"]["post"]["responses"][200]["content"]["application/json"];

type Manifest = Record<string, unknown>;
export type DiscoveryBadges = Record<string, "detected" | "guessed">;

const isEmpty = (v: unknown) =>
  v === undefined ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

/** Top-level manifest fields a proposal fills when the author has not touched them. */
const FILLABLE = ["display_name", "name", "documentation", "privacy_policies", "icon"] as const;

/** Whether the draft still analyses `analysedUrl`: an answer for another source is stale. */
export function isDiscoveryCurrent(manifest: Manifest, analysedUrl: string): boolean {
  const source = getSource(manifest);
  return source.kind === "remote" && source.remoteUrl === analysedUrl;
}

/**
 * A field is overwritten only while empty, the skeleton (`defaults`) or the previous analysis's
 * value, so a second analysis replaces the first; `source.remote` follows the URL. A stale
 * answer (see `isDiscoveryCurrent`) touches nothing. The transport changes only while it still
 * matches the value captured before the request.
 */
export function mergeDiscovery(
  current: Manifest,
  defaults: Manifest,
  proposal: Pick<DiscoveryProposal, "manifest">,
  analysedSource: Pick<ReturnType<typeof getSource>, "remoteUrl" | "remoteTransport">,
  previous?: Manifest,
): Manifest {
  if (!isDiscoveryCurrent(current, analysedSource.remoteUrl)) return current;
  const proposed: Manifest = proposal.manifest;
  const manifest: Manifest = { ...current };
  // The skeleton as typing the URL left it: its auth's allowlist follows the URL (`setSource`).
  const skeleton = setSource(defaults, getSource(current));
  const untouched = (key: string) =>
    isEmpty(current[key]) ||
    isDeepEqual(current[key], defaults[key]) ||
    isDeepEqual(current[key], skeleton[key]) ||
    (previous !== undefined && isDeepEqual(current[key], previous[key]));

  for (const key of FILLABLE) {
    if (proposed[key] !== undefined && untouched(key)) manifest[key] = proposed[key];
  }
  if (untouched("auths")) manifest.auths = proposed.auths;

  const remote = proposal.manifest.source.remote;
  const currentSource = asRecord(current.source);
  const transport = getSource(current).remoteTransport;
  manifest.source = {
    ...currentSource,
    kind: "remote",
    remote: {
      ...asRecord(currentSource.remote),
      url: remote.url,
      transport: transport === analysedSource.remoteTransport ? remote.transport : transport,
    },
  };
  return manifest;
}

/** The provenance of every proposed field the draft still holds as proposed. */
export function proposalBadges(
  manifest: Manifest,
  proposal: { manifest: Manifest; provenance: DiscoveryBadges },
): DiscoveryBadges {
  return Object.fromEntries(
    Object.entries(proposal.provenance).filter(([pointer]) =>
      isDeepEqual(valueAt(manifest, pointer), valueAt(proposal.manifest, pointer)),
    ),
  );
}

/** An RFC 6901 pointer lookup; `undefined` past a missing segment. */
function valueAt(root: unknown, pointer: string): unknown {
  let node = root;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    const record = asRecord(node);
    if (!hasOwn(record, key)) return undefined;
    node = record[key];
  }
  return node;
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) =>
    isDeepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Own keys only: a tool may be named `constructor`. (`Object.hasOwn` is past this lib target.) */
function hasOwn(record: Manifest, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function asRecord(v: unknown): Manifest {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Manifest) : {};
}

/** The provenance of the first applied badge under `prefix` (`/auths` covers `/auths/oauth`). */
export function badgeUnder(
  badges: DiscoveryBadges,
  prefix: string,
): DiscoveryBadges[string] | undefined {
  const pointer = Object.keys(badges).find((p) => p === prefix || p.startsWith(`${prefix}/`));
  return pointer ? badges[pointer] : undefined;
}

const SYNC_IDENTITY = ["display_name", "description", "homepage", "icon"] as const;

/**
 * `tools_policy` keeps each still-listed tool's entry (its scopes are the author's) and drops the
 * rest unless the list was truncated. `default_tools` is the author's (`[]` and `*` included): it
 * only loses unexposed tools, and when absent becomes every exposed listed tool. Identity is
 * filled only when empty.
 */
export function mergeServerSync(
  current: Manifest,
  proposal: Pick<ServerSyncProposal, "manifest" | "warnings">,
): Manifest {
  const proposed: Manifest = proposal.manifest;
  const listed = proposal.manifest.default_tools;
  const policy = asRecord(current.tools_policy);
  const truncated = proposal.warnings.some((w) => w.code === "tools_truncated");
  const names = [...(truncated ? Object.keys(policy) : []), ...listed];
  const manifest: Manifest = {
    ...current,
    tools_policy: Object.fromEntries(
      names.map((name) => [name, hasOwn(policy, name) ? policy[name] : {}]),
    ),
  };

  const exposed = new Set(
    resolveIntegrationToolCatalog({ integration: manifest as IntegrationManifest }).map(
      (entry) => entry.name,
    ),
  );
  const authored = current.default_tools;
  if (Array.isArray(authored)) {
    manifest.default_tools = authored.filter((name) => exposed.has(name));
  } else if (authored === undefined) {
    manifest.default_tools = listed.filter((name) => exposed.has(name));
  }

  for (const key of SYNC_IDENTITY) {
    if (proposed[key] !== undefined && isEmpty(current[key])) manifest[key] = proposed[key];
  }
  return manifest;
}

/** A sync proposal as `proposalBadges` reads one: every reported field is detected. */
export function serverSyncProvenance(proposal: Pick<ServerSyncProposal, "manifest">): {
  manifest: Manifest;
  provenance: DiscoveryBadges;
} {
  return {
    manifest: proposal.manifest,
    provenance: Object.fromEntries(
      Object.keys(proposal.manifest).map((key) => [`/${key}`, "detected" as const]),
    ),
  };
}

export type ServerSyncBody = NonNullable<
  paths["/api/integrations/{packageId}/discover"]["post"]["requestBody"]
>["content"]["application/json"];

/**
 * The proxy applies governance and selects a connection on the first request. An id is sent
 * only after the caller explicitly chooses a candidate from its refusal.
 */
export function serverSyncBody(connectionId?: string): ServerSyncBody {
  return connectionId ? { connection_id: connectionId } : {};
}

export type SyncCandidate = NonNullable<
  components["schemas"]["ConnectionResolutionItem"]["candidate_connections"]
>[number];

/** The connections a `409 must_choose_connection` sync refusal offers; `null` for any other error. */
export function syncConnectionCandidates(err: unknown): SyncCandidate[] | null {
  if (!(err instanceof ApiError) || err.code !== "must_choose_connection") return null;
  return (err.errors ?? []).flatMap(
    (item) => (item as { candidate_connections?: SyncCandidate[] }).candidate_connections ?? [],
  );
}
