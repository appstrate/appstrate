// SPDX-License-Identifier: Apache-2.0

import { hasOAuthAuth } from "./integration-tool-scopes";

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
  /** The integration's source is a remote server: a listing can be asked for. */
  remote: boolean;
  /** An OAuth integration: its tools without a permission are counted. */
  oauth: boolean;
}

/** The slice of the integration detail the snapshot reads. */
interface SnapshotDetail {
  tool_snapshot:
    (NonNullable<ToolSnapshotInfo["summary"]> & { connection_id: string | null }) | null;
  manifest: { source?: { kind?: string } };
  auths: readonly { type: string; connections: readonly { id: string; label: string }[] }[];
}

export function toolSnapshotInfo(packageId: string, detail: SnapshotDetail): ToolSnapshotInfo {
  const connectionId = detail.tool_snapshot?.connection_id;
  return {
    packageId,
    summary: detail.tool_snapshot,
    connectionLabel: connectionId
      ? (detail.auths
          .flatMap((auth) => auth.connections)
          .find((connection) => connection.id === connectionId)?.label ?? null)
      : null,
    remote: detail.manifest.source?.kind === "remote",
    oauth: hasOAuthAuth(detail.auths),
  };
}
