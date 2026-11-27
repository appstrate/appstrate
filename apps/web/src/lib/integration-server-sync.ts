// SPDX-License-Identifier: Apache-2.0

// The editor's server reads: the identity a server proposes merged into the draft, and the
// connection choice a refusal offers, shared with the tool snapshot's refresh.

import { ApiError } from "../api/errors";
import type { components, paths } from "../api/schema";
import { fileTextOperation } from "./package-file-drafts";
import type { PackageFileWriteOperation } from "./package-file-tree";

type Manifest = Record<string, unknown>;

/** Where the server's instructions are proposed; an existing file is never replaced. */
export const INTEGRATION_DOC = "INTEGRATION.md";

const isEmpty = (v: unknown) =>
  v === undefined ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

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

/**
 * The staged operations with the server's instructions written as `INTEGRATION.md`; the same
 * array when there are none or a write of that file is already staged (what the author staged
 * is never replaced). The server itself sends none when the saved draft has the file.
 */
export function stageServerDoc(
  operations: PackageFileWriteOperation[] | undefined,
  instructions: string | null,
): PackageFileWriteOperation[] | undefined {
  if (!instructions) return operations;
  const staged = (operations ?? []).some(
    (operation) => operation.op === "write" && operation.path === INTEGRATION_DOC,
  );
  return staged
    ? operations
    : [...(operations ?? []), fileTextOperation(INTEGRATION_DOC, instructions)];
}

/** Why a draft's server cannot be read yet; the control is shown disabled with this reason. */
export type ServerReadBlock = "sse" | "no_permission" | "no_connection";

export type ServerReadAvailability = "available" | ServerReadBlock | null;

/**
 * Whether a draft's server can be read: `null` when there is nothing to read (not a remote
 * source), `"available"`, or the reason it cannot yet. A templated URL is not a reason: the
 * server renders it with the chosen connection's variables.
 */
export function serverReadAvailability(
  source: { kind: string; transport?: string } | null | undefined,
  access: { unauthenticated: boolean; mayProxy: boolean; hasConnection: boolean },
): ServerReadAvailability {
  if (source?.kind !== "remote") return null;
  if (source.transport === "sse") return "sse";
  // A draft declaring no auths (AFPS §7.2) is read without the credential proxy nor a connection.
  if (access.unauthenticated) return "available";
  if (!access.mayProxy) return "no_permission";
  return access.hasConnection ? "available" : "no_connection";
}

/** The body of a server read (discover, tool-snapshot refresh): both take the same one. */
export type ConnectionChoiceBody = NonNullable<
  paths["/api/integrations/{packageId}/discover"]["post"]["requestBody"]
>["content"]["application/json"];

/** A connection id only once the caller chose a candidate from a refusal: governance picks first. */
export function connectionChoiceBody(connectionId?: string): ConnectionChoiceBody {
  return connectionId ? { connection_id: connectionId } : {};
}

export type ConnectionCandidate = NonNullable<
  components["schemas"]["ConnectionResolutionItem"]["candidate_connections"]
>[number];

/** The connections a `409 must_choose_connection` refusal offers; `null` for any other error. */
export function connectionChoiceCandidates(err: unknown): ConnectionCandidate[] | null {
  if (!(err instanceof ApiError) || err.code !== "must_choose_connection") return null;
  return (err.errors ?? []).flatMap(
    (item) =>
      (item as { candidate_connections?: ConnectionCandidate[] }).candidate_connections ?? [],
  );
}
