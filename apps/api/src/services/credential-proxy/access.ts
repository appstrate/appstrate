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
 *     `credential-proxy:call-own` the caller's own only, and only in a space whose admin left the
 *     proxy open ({@link reachOutsideRun}, `selectAccessibleConnection`).
 *
 * Every door reaching a connection's credential outside a run takes its reach from
 * {@link reachOutsideRun}: `/api/credential-proxy/{connections,proxy,tools,tools/call}` and the
 * authenticated `POST /api/integrations/{packageId}/discover`. The MCP module's
 * `call_integration_tool` re-enters those routes.
 */

import type { Actor } from "../../lib/actor.ts";
import type { Permission } from "../../lib/permissions.ts";
import { ApiError, forbidden } from "../../lib/errors.ts";
import type { SpaceContextRow } from "../../lib/space-lookup.ts";
import type { ProxyReach } from "../integration-connections.ts";
import { requireAttributableRun } from "../state/runs.ts";

/** Reaches the connections usable in the space, and opens the run path. */
const PROXY_CALL_PERMISSION = "credential-proxy:call" satisfies Permission;

function reachOf(permissions: ReadonlySet<string>): ProxyReach {
  return permissions.has(PROXY_CALL_PERMISSION) ? "usable" : "own";
}

/**
 * The reach of a call outside a run: `usable` under `credential-proxy:call`, `own` under
 * `call-own` alone. Throws `403 credential_proxy_closed` when the space's admin closed the proxy
 * outside a run (`spaces.credential_proxy_open`), whatever the caller's role, org owners and
 * admins included. A run's calls never come here: the platform's reach their connections through
 * the sidecar, a remote run's are bounded by {@link authorizeProxyCall}.
 */
export function reachOutsideRun(
  permissions: ReadonlySet<string>,
  space: Pick<SpaceContextRow, "id" | "name" | "credentialProxyOpen">,
): ProxyReach {
  if (!isCredentialProxyOpen(space)) {
    throw new ApiError({
      status: 403,
      code: "credential_proxy_closed",
      title: "Credential Proxy Closed",
      detail: credentialProxyClosedDetail(space),
    });
  }
  return reachOf(permissions);
}

/** Whether the space serves calls of the credential proxy made outside a run. */
export function isCredentialProxyOpen(
  space: Pick<SpaceContextRow, "credentialProxyOpen">,
): boolean {
  return space.credentialProxyOpen;
}

/** Outside a run: `credential-proxy:call-own`, which `credential-proxy:call` implies. */
const PROXY_CALL_OWN_PERMISSION = "credential-proxy:call-own" satisfies Permission;

/**
 * The reach a caller's permissions give outside a run, for a readiness verdict that reaches no
 * credential: `null` when it holds neither proxy permission, the caller the route refuses outright.
 */
export function reachOutsideRunIfPermitted(permissions: ReadonlySet<string>): ProxyReach | null {
  return permissions.has(PROXY_CALL_PERMISSION) || permissions.has(PROXY_CALL_OWN_PERMISSION)
    ? reachOf(permissions)
    : null;
}

/**
 * Why a closed space refuses a call outside a run: the `credential_proxy_closed` refusal of the
 * REST route and of the MCP module's org-wide `space_id` check.
 */
export function credentialProxyClosedDetail(space: { id: string; name: string }): string {
  return (
    `Space '${space.name}' (${space.id}) closes the credential proxy outside a run: its ` +
    "connections are reached by a run only. A space admin can reopen it in the space settings."
  );
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
