// SPDX-License-Identifier: Apache-2.0

/**
 * Connection rules a schedule write must pass: whose connections it may bind, and that its fire
 * is left with no connection choice to make.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections } from "@appstrate/db/schema";
import type { ConnectionOverrides, ConnectionResolutionError } from "@appstrate/core/integration";
import { collectAgentReadiness } from "./agent-readiness.ts";
import {
  launchOverrideLayer,
  missingIntegrationConnection,
  toLaunchOverrides,
  translateResolutionError,
  unavailableMemberError,
} from "./integration-connection-resolver.ts";
import { seedPinnedIntegrationManifests } from "./run-pipeline.ts";
import type { ResolutionFieldError } from "../lib/errors.ts";
import type { LoadedPackage } from "../types/index.ts";
import type { Actor } from "../lib/actor.ts";

/**
 * The verdicts only an edit of the schedule can clear: an open choice, an unreachable pick, a set
 * an admin pin or enforced default outranks, and — when the schedule's OWN set decided it — a
 * pick on an auth serving no selected tool or no pick at all for a required integration.
 */
function isScheduleOwned(e: ConnectionResolutionError): boolean {
  switch (e.code) {
    case "must_choose_connection":
    case "override_connection_unavailable":
    case "override_outranked":
      return true;
    case "auth_serves_no_selected_tool":
    case "required_integration_unbound":
      return e.source === "schedule_override";
    default:
      return false;
  }
}

/**
 * Who a schedule write acts for: the caller itself; another MEMBER, whose private connections the
 * caller must neither see nor bind; or an END USER, whose connections its caller picks.
 */
type ScheduleWriteFor = "self" | "member" | "end_user";

function scheduleWriteFor(caller: Actor, actor: Actor): ScheduleWriteFor {
  if (actor.type === "end_user") {
    return caller.type === "end_user" && caller.id === actor.id ? "self" : "end_user";
  }
  return caller.type === "user" && caller.id === actor.id ? "self" : "member";
}

/**
 * On every schedule write, a caller writing for another member binds only connections shared in
 * the space: 409 `override_connection_unavailable` otherwise, one refusal whatever the id, so it
 * cannot probe for private rows. A set this write changes neither the actor nor the ids of was
 * judged by the write that stored it and is exempt.
 */
export async function assertScheduleOverridesReachable(params: {
  spaceId: string;
  /** The schedule's actor after this write. */
  actor: Actor;
  caller: Actor;
  /** The overrides the row holds after this write. */
  connectionOverrides: ConnectionOverrides | null;
  /** The overrides on the row before it, `null` when the actor changes (or on create). */
  storedOverrides: ConnectionOverrides | null;
}): Promise<void> {
  if (scheduleWriteFor(params.caller, params.actor) !== "member") return;
  const named = Object.entries(params.connectionOverrides ?? {}).flatMap(([integrationId, ids]) =>
    sameSet(ids, params.storedOverrides?.[integrationId])
      ? []
      : ids.map((id): [string, string] => [integrationId, id]),
  );
  const shared = await sharedConnections(
    params.spaceId,
    named.map(([, id]) => id),
  );
  const refused = named.filter(([integrationId, id]) => shared.get(id) !== integrationId);
  if (refused.length === 0) return;
  const layer = launchOverrideLayer("schedule_override");
  throw missingIntegrationConnection(
    refused.map(([integrationId, id]) =>
      translateResolutionError(unavailableMemberError(integrationId, layer, id)),
    ),
  );
}

/** Connections among `ids` shared in `spaceId`: id → integration id. */
async function sharedConnections(spaceId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: integrationConnections.id, integrationId: integrationConnections.integrationId })
    .from(integrationConnections)
    .where(
      and(
        inArray(integrationConnections.id, ids),
        eq(integrationConnections.spaceId, spaceId),
        eq(integrationConnections.sharedWithOrg, true),
      ),
    );
  return new Map(rows.map((r) => [r.id, r.integrationId]));
}

export function sameSet(a: readonly string[], b: readonly string[] | undefined): boolean {
  return b !== undefined && a.length === b.length && a.every((id) => b.includes(id));
}

/** Whether two maps hold the same keys with `eq` values; `null` and `{}` are both empty. */
export function sameRecord<T>(
  a: Readonly<Record<string, T>> | null,
  b: Readonly<Record<string, T>> | null,
  eq: (x: T, y: T) => boolean,
): boolean {
  const ids = Object.keys(a ?? {});
  return (
    ids.length === Object.keys(b ?? {}).length &&
    ids.every((id) => b !== null && id in b && eq(a![id]!, b[id]!))
  );
}

/**
 * Refuse arming a schedule whose fire would fail on its own connection choice: an unattended run
 * cannot ask, so the choice is made at write time. The fire's readiness, keeping only
 * {@link isScheduleOwned} verdicts (the rest stay failed runs at the tick); non-throwing, so no
 * `onRunConnectionMissing` fires for a run nobody launched. Worded for whoever writes
 * ({@link scheduleWriteFor}). Returns the fire's warnings, or `null` to a caller writing for
 * another member, who must not learn how many connections the actor holds.
 */
export async function assertScheduleConnectionsChosen(params: {
  /** The agent at the version the schedule fires (`version_override` resolved). */
  agent: LoadedPackage;
  orgId: string;
  spaceId: string;
  /** The schedule's actor — whose reach the fire resolves with. */
  actor: Actor;
  /** Who writes the schedule. */
  caller: Actor;
  /** The overrides this write stores — already judged by {@link assertScheduleOverridesReachable}. */
  connectionOverrides: ConnectionOverrides | null;
  dependencyOverrides: Record<string, string> | null;
}): Promise<ResolutionFieldError[] | null> {
  const manifestCache = await seedPinnedIntegrationManifests(params);
  const { resolutionErrors, warnings } = await collectAgentReadiness({
    agent: params.agent,
    orgId: params.orgId,
    spaceId: params.spaceId,
    actor: params.actor,
    launchOverrides: toLaunchOverrides(params.connectionOverrides, "schedule_override"),
    manifestCache,
  });
  const writeFor = scheduleWriteFor(params.caller, params.actor);
  const unchosen = resolutionErrors.filter(isScheduleOwned);
  if (unchosen.length === 0) return writeFor === "member" ? null : warnings;
  switch (writeFor) {
    case "self":
      throw missingIntegrationConnection(unchosen.map(translateResolutionError));
    case "member":
      throw missingIntegrationConnection(await withSharedCandidatesOnly(unchosen, params.spaceId));
    case "end_user":
      throw missingIntegrationConnection(
        unchosen.map((e) =>
          translateResolutionError(
            e.code === "must_choose_connection"
              ? {
                  ...e,
                  message: `Integration '${e.integrationId}' needs a connection choice for the schedule's end-user actor — name one of the candidates in connection_overrides.`,
                }
              : e,
          ),
        ),
      );
  }
}

/**
 * The refusal as a caller acting for another member may read it: a choice lists only shared
 * candidates, and an item about an unshared connection names no label or account — only its id,
 * which the schedule's own set already holds.
 */
async function withSharedCandidatesOnly(
  errors: ConnectionResolutionError[],
  spaceId: string,
): Promise<ResolutionFieldError[]> {
  const shared = await sharedConnections(
    spaceId,
    errors.flatMap((e) => [
      ...(e.candidateConnections ?? []).map((c) => c.id),
      ...(e.connectionId ? [e.connectionId] : []),
    ]),
  );
  return errors.map((e) => {
    if (e.code !== "must_choose_connection") {
      if (!e.connectionId || shared.has(e.connectionId)) return translateResolutionError(e);
      return translateResolutionError({
        ...e,
        message: `A connection in the schedule's set for ${e.integrationId} cannot serve this run (${e.code}) — only the schedule's actor can see it; remove it from the set or ask them.`,
      });
    }
    const candidates = (e.candidateConnections ?? []).filter((c) => shared.has(c.id));
    return translateResolutionError({
      ...e,
      candidateConnections: candidates,
      message:
        candidates.length > 0
          ? `Integration '${e.integrationId}' needs a connection choice for the schedule's actor: pick one of the shared connections, or the actor pins one of their own for this agent.`
          : `Integration '${e.integrationId}' needs a connection choice only the schedule's actor can make (a member pin of their own for this agent) or an admin can make (an admin pin).`,
    });
  });
}
