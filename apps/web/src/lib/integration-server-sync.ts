// SPDX-License-Identifier: Apache-2.0

// The creation wizard's server discovery: the merge of the server's proposal into the draft. Also
// the connection choice a refusal offers, shared with the tool listing's refresh.

import {
  resolveIntegrationToolCatalog,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import { asRecord } from "@appstrate/core/safe-json";
import { ApiError } from "../api/errors";
import type { components, paths } from "../api/schema";

export type ServerSyncProposal =
  paths["/api/integrations/{packageId}/discover"]["post"]["responses"][200]["content"]["application/json"];

type Manifest = Record<string, unknown>;

/** Where a sync proposes the server's instructions; an existing file is never replaced. */
export const INTEGRATION_DOC = "INTEGRATION.md";

const isEmpty = (v: unknown) =>
  v === undefined ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

/** Own keys only: a tool may be named `constructor`. */
function hasOwn(record: Manifest, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** The identity a server proposes: filled into a draft only where the author left it empty. */
const SERVER_IDENTITY_KEYS = ["display_name", "description", "homepage", "icon"] as const;
export type ServerIdentityKey = (typeof SERVER_IDENTITY_KEYS)[number];

/**
 * Fills the identity fields of `current` that are empty and that the server proposes; a field the
 * author wrote is never replaced. `filled` names what changed, in `SERVER_IDENTITY_KEYS` order.
 */
export function mergeServerIdentity(
  current: Manifest,
  proposed: Manifest,
): { manifest: Manifest; filled: ServerIdentityKey[] } {
  const manifest: Manifest = { ...current };
  const filled: ServerIdentityKey[] = [];
  for (const key of SERVER_IDENTITY_KEYS) {
    if (proposed[key] !== undefined && isEmpty(current[key])) {
      manifest[key] = proposed[key];
      filled.push(key);
    }
  }
  return { manifest, filled };
}

/** Why a draft's server cannot be read yet; the control is shown disabled with this reason. */
export type ServerReadBlock = "sse" | "no_permission" | "no_connection";

/**
 * Whether a draft's server can be read: `null` when there is nothing to read (not a remote
 * source), `"available"`, or the reason it cannot yet. A templated URL is not a reason: the
 * server renders it with the chosen connection's variables.
 */
export function serverReadAvailability(
  source: { kind: string; transport?: string } | null | undefined,
  access: { unauthenticated: boolean; mayProxy: boolean; hasConnection: boolean },
): "available" | ServerReadBlock | null {
  if (source?.kind !== "remote") return null;
  if (source.transport === "sse") return "sse";
  // A draft declaring no auths (AFPS §7.2) is read without the credential proxy nor a connection.
  if (access.unauthenticated) return "available";
  if (!access.mayProxy) return "no_permission";
  return access.hasConnection ? "available" : "no_connection";
}

/** Whether the server listed more tools than were read: what is not listed may still exist. */
export function isToolsTruncated(proposal: Pick<ServerSyncProposal, "warnings">): boolean {
  return proposal.warnings.some((w) => w.code === "tools_truncated");
}

/**
 * `tools_policy` keeps each still-listed tool's entry (its scopes are the author's) and drops the
 * rest unless the list was truncated. The draft's key order is kept, new tools are appended: the
 * editor's dirty check compares serialized JSON, so a reorder would read as an edit. `default_tools` is the author's: it only loses unexposed
 * tools, and when absent becomes the proposal's pre-selection. Identity is filled only when empty.
 */
export function mergeServerSync(
  current: Manifest,
  proposal: Pick<ServerSyncProposal, "manifest" | "warnings">,
): Manifest {
  const proposed: Manifest = proposal.manifest;
  const listed = Object.keys(proposal.manifest.tools_policy);
  const policy = asRecord(current.tools_policy);
  const truncated = isToolsTruncated(proposal);
  const listedSet = new Set(listed);
  const kept = Object.keys(policy).filter((name) => truncated || listedSet.has(name));
  const names = [...kept, ...listed.filter((name) => !hasOwn(policy, name))];
  const manifest: Manifest = {
    ...mergeServerIdentity(current, proposed).manifest,
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

  return manifest;
}

/** The body of a server read (discover, tool-snapshot refresh): both take the same one. */
export type ConnectionChoiceBody = NonNullable<
  paths["/api/integrations/{packageId}/discover"]["post"]["requestBody"]
>["content"]["application/json"];

/** A connection id only once the caller chose a candidate from a refusal: governance picks first. */
export function connectionChoiceBody(connectionId?: string): ConnectionChoiceBody {
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
