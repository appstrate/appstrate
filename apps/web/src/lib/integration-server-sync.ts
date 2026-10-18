// SPDX-License-Identifier: Apache-2.0

// Server sync of a published integration: the request body, the connection choice a refusal
// offers, and the merge of the server's answer into the draft.

import {
  resolveIntegrationToolCatalog,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import { ApiError } from "../api/errors";
import type { components, paths } from "../api/schema";

export type ServerSyncProposal =
  paths["/api/integrations/{packageId}/discover"]["post"]["responses"][200]["content"]["application/json"];

type Manifest = Record<string, unknown>;
/** Whether a field was read from the server or inferred. */
export type Provenance = "detected" | "guessed";

const isEmpty = (v: unknown) =>
  v === undefined ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

/** Own keys only: a tool may be named `constructor`. (`Object.hasOwn` is past this lib target.) */
function hasOwn(record: Manifest, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function asRecord(v: unknown): Manifest {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Manifest) : {};
}

const SYNC_IDENTITY = ["display_name", "description", "homepage", "icon"] as const;

/**
 * `tools_policy` keeps each still-listed tool's entry (its scopes are the author's) and drops the
 * rest unless the list was truncated. `default_tools` is the author's (`[]` and `*` included): it
 * only loses unexposed tools, and when absent becomes the proposal's pre-selection (the tools the
 * server annotates read-only), exposed ones only. Identity is filled only when empty.
 */
export function mergeServerSync(
  current: Manifest,
  proposal: Pick<ServerSyncProposal, "manifest" | "warnings">,
): Manifest {
  const proposed: Manifest = proposal.manifest;
  const listed = Object.keys(proposal.manifest.tools_policy);
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
    manifest.default_tools = proposal.manifest.default_tools.filter((name) => exposed.has(name));
  }

  for (const key of SYNC_IDENTITY) {
    if (proposed[key] !== undefined && isEmpty(current[key])) manifest[key] = proposed[key];
  }
  return manifest;
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
