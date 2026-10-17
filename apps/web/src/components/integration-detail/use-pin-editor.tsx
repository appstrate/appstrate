// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from "react";
import type {
  ConsumingAgentSummary,
  IntegrationConnection,
  IntegrationPin,
} from "@appstrate/shared-types";
import {
  useIntegrationPins,
  useIntegrationConnections,
  useAgentsConsumingIntegration,
  useIntegrationOrgDefault,
  useDeleteIntegrationPin,
} from "../../hooks/use-integrations";
import { PinDeleteConfirm, PinFormModal, type PinForm } from "./pin-editor";

/**
 * An integration's admin pins, as every screen that edits them needs them: the pins, the
 * connections a pin can name (shared into the space), the active agents that use the integration,
 * whether the space default is enforced, and the pin's two dialogs, mounted only while open (closing
 * abandons the draft). The integration page's pins table and the agent's Connexions rows both edit
 * through it, so they open the same form and the same confirmation, and their writes invalidate the
 * same reads (`invalidateIntegrationQueries`: the pins, and every readiness verdict).
 */
export function usePinEditor(packageId: string): PinEditor {
  const { data: pins, isLoading: pinsLoading, error: pinsError } = useIntegrationPins(packageId);
  const { data: connections, isLoading: connectionsLoading } = useIntegrationConnections(packageId);
  const { data: consumingAgents, isLoading: agentsLoading } =
    useAgentsConsumingIntegration(packageId);
  // An enforced default accepts only « exact »: no pin of this integration may leave it meanwhile.
  const { data: orgDefault } = useIntegrationOrgDefault(packageId);
  const deletePin = useDeleteIntegrationPin();

  const [form, setForm] = useState<PinForm | null>(null);
  const [toDelete, setToDelete] = useState<IntegrationPin | null>(null);

  const pinnable = (connections ?? []).filter((c) => c.shared_here);
  const agentName = (id: string) =>
    consumingAgents?.find((a) => a.agent_package_id === id)?.display_name ?? id;
  const pinned = new Set((pins ?? []).map((p) => p.agent_package_id));
  const unpinnedAgents = (consumingAgents ?? []).filter((a) => !pinned.has(a.agent_package_id));
  const agentOf = (id: string): ConsumingAgentSummary => ({
    agent_package_id: id,
    display_name: agentName(id),
  });

  // Until the connections load, a stored member cannot be told unavailable, nor a set offered.
  const loaded = connections !== undefined;

  return {
    pins,
    pinsLoading,
    pinsError,
    connections,
    connectionsLoading,
    agentsLoading,
    consumingAgents,
    pinnable,
    unpinnedAgents,
    agentName,
    edit: loaded ? (pin) => setForm({ pin, agents: [agentOf(pin.agent_package_id)] }) : undefined,
    add: loaded
      ? (agentId) =>
          setForm({ pin: null, agents: agentId ? [agentOf(agentId)] : unpinnedAgents, agentId })
      : undefined,
    remove: setToDelete,
    isDeleting: (pin) => deletePin.isPending && toDelete?.agent_package_id === pin.agent_package_id,
    dialogs: (
      <>
        {form && (
          <PinFormModal
            packageId={packageId}
            pin={form.pin}
            agents={form.agents}
            agentId={form.agentId}
            connections={pinnable}
            enforcedDefault={orgDefault?.enforce === true}
            onClose={() => setForm(null)}
          />
        )}
        {/* Mounted only for the pin the menu named: no stale target, and only its button deletes. */}
        {toDelete && (
          <PinDeleteConfirm
            pin={toDelete}
            agent={agentName(toDelete.agent_package_id)}
            isPending={deletePin.isPending}
            onClose={() => setToDelete(null)}
            onConfirm={() =>
              deletePin.mutate(
                { params: { path: { packageId, agentPackageId: toDelete.agent_package_id } } },
                { onSuccess: () => setToDelete(null) },
              )
            }
          />
        )}
      </>
    ),
  };
}

export interface PinEditor {
  pins: IntegrationPin[] | undefined;
  pinsLoading: boolean;
  pinsError: unknown;
  /** Undefined while loading: an unknown connection is then not yet "unavailable". */
  connections: IntegrationConnection[] | undefined;
  connectionsLoading: boolean;
  agentsLoading: boolean;
  /** The agents active in the space that use the integration: the only ones a pin can be written for. */
  consumingAgents: ConsumingAgentSummary[] | undefined;
  /** The connections shared into this space: the ones a pin can name. */
  pinnable: IntegrationConnection[];
  /** The consuming agents without a pin yet. */
  unpinnedAgents: ConsumingAgentSummary[];
  agentName: (agentPackageId: string) => string;
  /** Opens the form on a stored pin, its agent fixed. Undefined until the connections load. */
  edit: ((pin: IntegrationPin) => void) | undefined;
  /**
   * Opens the form for a new pin: its agent fixed to `agentId`, else chosen among the agents
   * without one. Undefined until the connections load.
   */
  add: ((agentId?: string) => void) | undefined;
  /** Asks to delete: only the confirmation's button deletes. */
  remove: (pin: IntegrationPin) => void;
  /** Only the pin being deleted shows the spinner. */
  isDeleting: (pin: IntegrationPin) => boolean;
  /** The form and the confirmation, for the caller to render. */
  dialogs: ReactNode;
}
