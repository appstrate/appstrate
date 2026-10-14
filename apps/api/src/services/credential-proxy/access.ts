// SPDX-License-Identifier: Apache-2.0

/**
 * Who may call the credential proxy. Decided here from the caller, so every door that reaches the
 * proxy (the REST route, and through it the MCP module's `api_call` tool, its one MCP path)
 * applies one rule:
 *
 *   - for a run (`X-Run-Id`): `credential-proxy:call`, and the run is the actor's own, in flight,
 *     and executed by the caller ({@link requireCallerRun}). It reaches what the run bound, a
 *     colleague's shared connection included, which is why launching runs (`agents:run`) is not
 *     enough: registering a remote run would otherwise hand out raw access to that connection.
 *   - outside a run: `credential-proxy:call` reaches the connections usable in the space,
 *     `credential-proxy:call-own` the caller's own only ({@link reachOutsideRun},
 *     `selectAccessibleConnection`).
 */

import { PROXY_CALL_PERMISSIONS } from "@appstrate/core/permissions";
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

interface ProxyAccessInput {
  /** The caller's effective permissions in the space. */
  permissions: ReadonlySet<string>;
  orgId: string;
  spaceId: string;
  actor: Actor;
  /** The run the call names with `X-Run-Id`; `null` outside a run. */
  runId: string | null;
  /** Receives the permission a refusal names, for the door's denial audit. */
  onDenied: (required: string) => void;
}

/** Throws unless the caller may take the path its `runId` selects. */
export async function authorizeProxyCall(input: ProxyAccessInput): Promise<void> {
  const { permissions, orgId, spaceId, actor, runId, onDenied } = input;
  if (runId === null) {
    if (PROXY_CALL_PERMISSIONS.some((permission) => permissions.has(permission))) return;
    const required = PROXY_CALL_PERMISSIONS.join("|");
    onDenied(required);
    throw forbidden(
      `Insufficient permissions: ${required} required to call the credential proxy outside a run`,
    );
  }
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
