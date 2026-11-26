// SPDX-License-Identifier: Apache-2.0

import type { paths } from "../api/client";
import { hasOAuthAuth } from "./integration-tool-scopes";
import type { ServerReadBlock, serverReadAvailability } from "./integration-server-sync";

type IntegrationDetail =
  paths["/api/integrations/{packageId}"]["get"]["responses"]["200"]["content"]["application/json"];

/** Why « Relire le serveur » would be refused; it is shown disabled with this reason. */
export type SnapshotRefreshBlock = ServerReadBlock | "inactive" | "unpublished";

/** The server's last stored listing, with what the tools section needs to show it and ask for another. */
export interface ToolSnapshot {
  /** `tool_snapshot` of the integration detail. */
  summary: IntegrationDetail["tool_snapshot"];
  /** The label of the connection the server was listed with; `null` for none (or one since removed). */
  connectionLabel: string | null;
  /** An OAuth integration: its tools without a permission are counted. */
  oauth: boolean;
  /** `null`: the listing can be asked for. */
  refreshBlock: SnapshotRefreshBlock | null;
}

/**
 * The snapshot of a remote Streamable HTTP server, `undefined` for any other source (an SSE
 * server cannot be listed). `availability` is the server-read verdict of the source;
 * the refresh adds its own two refusals: the listing is read from the latest published version,
 * and the route refuses an integration inactive in the space.
 */
export function toolSnapshot(
  detail: Pick<IntegrationDetail, "active" | "tool_snapshot"> & {
    auths: readonly { type: string; connections: readonly { id: string; label: string }[] }[];
  },
  availability: ReturnType<typeof serverReadAvailability>,
  published: boolean,
): ToolSnapshot | undefined {
  if (availability === null || availability === "sse") return undefined;
  const connectionId = detail.tool_snapshot?.connection_id;
  return {
    summary: detail.tool_snapshot,
    connectionLabel: connectionId
      ? (detail.auths
          .flatMap((auth) => auth.connections)
          .find((connection) => connection.id === connectionId)?.label ?? null)
      : null,
    oauth: hasOAuthAuth(detail.auths),
    refreshBlock: !published
      ? "unpublished"
      : !detail.active
        ? "inactive"
        : availability === "available"
          ? null
          : availability,
  };
}
