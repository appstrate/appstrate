// SPDX-License-Identifier: Apache-2.0

/**
 * Who may call the credential proxy. The route admits a caller holding `credential-proxy:call-own`,
 * which `credential-proxy:call` implies; what a call may reach depends on which the caller holds:
 *
 *   - for a run (`X-Run-Id`): `credential-proxy:call`, and the run is the actor's own, in flight,
 *     and executed by the caller ({@link requireCallerRun}). It reaches what the run bound, a
 *     colleague's shared connection included, which is why launching runs (`agents:run`) is not
 *     enough: registering a remote run would otherwise hand out raw access to that connection.
 *   - outside a run: `credential-proxy:call` reaches the connections usable in the space,
 *     `credential-proxy:call-own` the caller's own only ({@link reachOutsideRun},
 *     `selectAccessibleConnection`).
 *
 * The REST route decides it here, and the MCP module's `api_call` tool re-enters that route.
 */

import type { Actor } from "../../lib/actor.ts";
import type { Permission } from "../../lib/permissions.ts";
import { forbidden } from "../../lib/errors.ts";
import type { ProxyReach } from "../integration-connections.ts";
import { requireAttributableRun } from "../state/runs.ts";

/** Reaches the connections usable in the space, and opens the run path. */
const PROXY_CALL_PERMISSION = "credential-proxy:call" satisfies Permission;

/** Outside a run: `usable` under `credential-proxy:call`, `own` under `call-own` alone. */
export function reachOutsideRun(permissions: ReadonlySet<string>): ProxyReach {
  return permissions.has(PROXY_CALL_PERMISSION) ? "usable" : "own";
}

/** Throws unless the caller may call the proxy for the run it names with `X-Run-Id`. */
export async function authorizeProxyCall(input: {
  /** The caller's effective permissions in the space. */
  permissions: ReadonlySet<string>;
  orgId: string;
  spaceId: string;
  actor: Actor;
  runId: string;
  /** Receives the permission a refusal names, for the door's denial audit. */
  onDenied: (required: string) => void;
}): Promise<void> {
  const { permissions, orgId, spaceId, actor, runId, onDenied } = input;
  if (!permissions.has(PROXY_CALL_PERMISSION)) {
    onDenied(PROXY_CALL_PERMISSION);
    throw forbidden(
      `Insufficient permissions: ${PROXY_CALL_PERMISSION} required to call the credential proxy ` +
        `for a run (X-Run-Id)`,
    );
  }
  await requireCallerRun({ orgId, spaceId, runId, actor });
}

/**
 * The run a proxy call borrows from: the actor's own, in flight (`requireAttributableRun`), and
 * executed by the caller (`run_origin = 'remote'`). A run the platform executes reaches its
 * connections from inside its sandbox, through the sidecar: lending them here would hand them to
 * whoever launched it, outside that sandbox.
 */
export async function requireCallerRun(input: {
  orgId: string;
  spaceId: string;
  runId: string;
  actor: Actor;
}) {
  const { orgId, spaceId, runId, actor } = input;
  const run = await requireAttributableRun({ orgId, runId, spaceId, owner: actor });
  if (run.runOrigin !== "remote") {
    throw forbidden(
      "X-Run-Id names a run the platform executes: its connections are reached from inside that run only",
    );
  }
  return run;
}
