// SPDX-License-Identifier: Apache-2.0

/**
 * What a remote MCP server says about itself, for the editor's « Remplir depuis le serveur »: its
 * `serverInfo` and `instructions`, as a manifest proposal of identity fields. Tools are not read
 * here: the tool snapshot (`remote-tools.ts`) is the one path that lists them, caches, fingerprints
 * and records them for the published version. The session is that path's too (`withMcpSession`):
 * through the credential proxy (`proxyCall`) once a connection exists, so connection selection,
 * `authorized_uris`, the egress guard and the 401 refresh are the proxy's; for an unauthenticated
 * integration (AFPS §7.2), directly, egress-guarded on every hop. Either is journaled like a call
 * outside a run. Persists nothing: it reads the DRAFT, which no snapshot ever records.
 */

import type { Implementation } from "@modelcontextprotocol/sdk/types.js";
import { isUnauthenticatedIntegration } from "@appstrate/core/integration";
import { isIconImage } from "@appstrate/core/appearance";
import { PACKAGE_CONTENT_ENTRY } from "@appstrate/core/package-files";
import type { Actor } from "../lib/actor.ts";
import { ApiError } from "../lib/errors.ts";
import { fetchWithin } from "../lib/egress-host-guard.ts";
import type { SpaceScope } from "../lib/scope.ts";
import { ProxyCallError } from "./credential-proxy/core.ts";
import {
  resolveRemoteConnection,
  streamableRemote,
  withMcpSession,
} from "./credential-proxy/remote-tools.ts";
import { mcpServerFailure } from "./credential-proxy/mcp-over-proxy.ts";
import type { ProxyCaller } from "./credential-proxy/call-journal.ts";
import type { ProxyReach } from "./integration-connections.ts";
import {
  readIntegrationManifestForRun,
  type ResolvedIntegrationVersion,
} from "./integration-service.ts";
import { downloadPackageFiles } from "./package-items/storage.ts";
import { fetchServerIcon, siteIconFetch } from "./integration-icon.ts";
import { serverIdentityFields } from "./integration-discovery.ts";

export interface ServerSyncProposal {
  /** The identity fields the server proposes (`display_name`, `description`, `homepage`, `icon`). */
  manifest: Record<string, unknown>;
  iconSource: string | null;
  /** The server's `instructions`, for the editor to propose as `INTEGRATION.md`. */
  instructions: string | null;
  warnings: { code: string; message: string }[];
}

/** The sync reads, and the proxy authorizes against, the draft its route lets a home writer edit. */
const DRAFT: ResolvedIntegrationVersion = { source: "draft", version: null };
const SYNC_TIMEOUT_MS = 20_000;
/** `instructions` is the server's free text, proposed as a file: bounded like one. */
const MAX_INSTRUCTIONS_BYTES = 32 * 1024;

export async function syncIntegrationFromServer(input: {
  scope: SpaceScope;
  actor: Actor;
  packageId: string;
  connectionId?: string;
  /** The caller's proxy reach, asked only on the proxied path: it throws when the caller has none. */
  proxyReach: () => ProxyReach;
  /** Who called, as the call journal records it. */
  caller: ProxyCaller;
  /** The caller's request: its going away ends the sync. */
  signal?: AbortSignal;
}): Promise<ServerSyncProposal> {
  const { scope, packageId } = input;
  // The draft being edited, published or not: `proxyCall` authorizes the exchange against it too.
  const loaded = await readIntegrationManifestForRun(packageId, DRAFT);
  if (!loaded.ok) {
    throw new ApiError({
      status: 400,
      code: "invalid_draft_manifest",
      title: "Invalid Draft Manifest",
      detail: `Draft for '${packageId}' is invalid; fix the manifest before synchronizing.`,
    });
  }
  streamableRemote(packageId, loaded.manifest);

  const unauthenticated = isUnauthenticatedIntegration(loaded.manifest);
  // Read only for an authenticated integration, which has a reach.
  const reach = unauthenticated ? "own" : input.proxyReach();
  // The URL is the chosen connection's rendering (AFPS §7.12); the draft's manifest decides it.
  const { connectionId, url } = await resolveRemoteConnection(
    {
      scope,
      actor: input.actor,
      integrationId: packageId,
      reach,
      connectOffers: null,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    },
    loaded.manifest,
  ).catch((err: unknown) => {
    if (err instanceof ApiError && err.code === "credential_not_found") {
      throw notConnected(err.message);
    }
    throw err;
  });

  // One bound for the whole sync, the icon lookup included.
  const timeout = AbortSignal.timeout(SYNC_TIMEOUT_MS);
  const deadline = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;

  // Alongside the exchange; a storage fault surfaces as itself, not as an MCP failure.
  const hasDoc = draftHasIntegrationDoc(scope.orgId, packageId);
  hasDoc.catch(() => {});

  const exchanged = await withMcpSession(
    {
      scope,
      actor: input.actor,
      integrationId: packageId,
      caller: input.caller,
      reach,
      connectOffers: null,
      connectionId,
      timeoutMs: SYNC_TIMEOUT_MS,
      signal: deadline,
      version: DRAFT,
    },
    url,
    async (client) => ({
      info: client.getServerVersion(),
      instructions: client.getInstructions(),
    }),
    (err, receivedStatus) => syncFailure(err, packageId, url, unauthenticated, receivedStatus),
  );
  return proposalFromServer(
    {
      url,
      info: exchanged.info,
      // Never proposed over the package's own document.
      instructions: exchanged.instructions && (await hasDoc) ? undefined : exchanged.instructions,
    },
    // Best-effort: past the deadline it finds nothing.
    fetchWithin(siteIconFetch(), deadline),
  );
}

/** Whether the draft's stored tree holds an `INTEGRATION.md`, whatever its content. */
async function draftHasIntegrationDoc(orgId: string, packageId: string): Promise<boolean> {
  const path = PACKAGE_CONTENT_ENTRY.integration?.path;
  const files = await downloadPackageFiles("integrations", orgId, packageId, undefined, "org");
  return path !== undefined && files !== null && Object.hasOwn(files, path);
}

/** The proposal a server's answers make. Exported for unit tests. */
export async function proposalFromServer(
  server: {
    url: string;
    info: Implementation | undefined;
    instructions: string | undefined;
  },
  /** Returns redirects unfollowed: the icon lookup judges each hop. */
  fetchImpl: typeof fetch,
): Promise<ServerSyncProposal> {
  const { info } = server;
  const manifest: Record<string, unknown> = { ...serverIdentityFields(info) };

  const iconSource = await fetchServerIcon(server.url, info, fetchImpl);
  // Only an icon the manifest accepts as is; any other raster is the editor's to re-encode.
  if (iconSource && isIconImage(iconSource)) manifest.icon = iconSource;

  const warnings: ServerSyncProposal["warnings"] = [];
  const instructions = capInstructions(server.instructions?.trim() ?? "");
  if (instructions.truncated) {
    warnings.push({
      code: "instructions_truncated",
      message: `The server's instructions exceed ${MAX_INSTRUCTIONS_BYTES / 1024} KiB: they are cut at the last line that fits.`,
    });
  }
  return { manifest, iconSource, instructions: instructions.text || null, warnings };
}

/** At most {@link MAX_INSTRUCTIONS_BYTES} of UTF-8, cut after the last whole line that fits. */
function capInstructions(text: string): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= MAX_INSTRUCTIONS_BYTES) return { text, truncated: false };
  // A code point split at the cap decodes as U+FFFD: dropped.
  const head = new TextDecoder()
    .decode(bytes.subarray(0, MAX_INSTRUCTIONS_BYTES))
    .replace(/\uFFFD$/, "");
  const lineEnd = head.lastIndexOf("\n");
  return { text: (lineEnd > 0 ? head.slice(0, lineEnd) : head).trimEnd(), truncated: true };
}

const notConnected = (detail: string) =>
  new ApiError({
    status: 409,
    code: "integration_not_connected",
    title: "Integration Not Connected",
    detail,
  });

function syncFailure(
  err: unknown,
  packageId: string,
  url: string,
  unauthenticated: boolean,
  receivedStatus: number | undefined,
): Error {
  if (err instanceof ProxyCallError && err.code === "credential_not_found") {
    return notConnected(err.message);
  }
  // AFPS §7.2: for an unauthenticated integration a challenge makes it unavailable, never an ad
  // hoc authorization.
  return mcpServerFailure(err, {
    integrationId: packageId,
    url,
    unauthenticated,
    failed: "could not be synchronized",
    ...(receivedStatus !== undefined ? { receivedStatus } : {}),
  });
}
