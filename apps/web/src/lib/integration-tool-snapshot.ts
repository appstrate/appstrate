// SPDX-License-Identifier: Apache-2.0

import { hasOAuthAuth } from "./integration-tool-scopes";
import { readIntegrationSource } from "./package-manifest";

/** The server's last stored listing, with what the tools section needs to show it and ask for another. */
export interface ToolSnapshotInfo {
  packageId: string;
  /** `tool_snapshot` of the integration detail. */
  summary: {
    listed_at: string;
    added: number;
    missing: number;
    modified: number;
    /** The listing was cut at the size cap: a tool it lacks is not proven gone. */
    truncated: boolean;
  } | null;
  /** The label of the connection the server was listed with; `null` for none (or one since removed). */
  connectionLabel: string | null;
  /** The source is a Streamable HTTP remote server (an SSE one cannot be listed): a listing can be asked for. */
  remote: boolean;
  /** A version is published: the listing is read from the latest one, so there is none to read before. */
  published: boolean;
  /** An OAuth integration: its tools without a permission are counted. */
  oauth: boolean;
}

/** The slice of the integration detail the snapshot reads. */
interface SnapshotDetail {
  tool_snapshot:
    (NonNullable<ToolSnapshotInfo["summary"]> & { connection_id: string | null }) | null;
  manifest: { source?: unknown };
  auths: readonly { type: string; connections: readonly { id: string; label: string }[] }[];
}

export function toolSnapshotInfo(
  packageId: string,
  detail: SnapshotDetail,
  published: boolean,
): ToolSnapshotInfo {
  const source = readIntegrationSource(detail.manifest.source);
  const connectionId = detail.tool_snapshot?.connection_id;
  return {
    packageId,
    summary: detail.tool_snapshot,
    connectionLabel: connectionId
      ? (detail.auths
          .flatMap((auth) => auth.connections)
          .find((connection) => connection.id === connectionId)?.label ?? null)
      : null,
    remote: source?.kind === "remote" && source.transport !== "sse",
    published,
    oauth: hasOAuthAuth(detail.auths),
  };
}
