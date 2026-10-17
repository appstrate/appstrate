// SPDX-License-Identifier: Apache-2.0

import { Pencil, Pin, PinOff } from "lucide-react";
import type { IntegrationPin } from "@appstrate/shared-types";
import type { MenuAction } from "../../lib/menu-action";
import type { PinEditor } from "../integration-detail/use-pin-editor";

/**
 * Imposing a set when the agent has no pin, else editing or removing it. No « Imposer » for an
 * agent not active in the space, which the server refuses to pin; editing waits for the
 * connections; removing only opens the confirmation.
 */
export function pinRowActions({
  t,
  integrationId,
  agentPackageId,
  pin,
  agentActive,
  editor: { edit, add, remove },
}: {
  t: (key: string) => string;
  integrationId: string;
  agentPackageId: string;
  /** This agent's pin of the integration, if any. */
  pin: IntegrationPin | undefined;
  /** Whether the agent is among the integration's consuming agents (active in the space). */
  agentActive: boolean;
  editor: Pick<PinEditor, "edit" | "add" | "remove">;
}): MenuAction[] {
  if (!pin) {
    return [
      {
        id: "impose",
        label: t("detail.connectionsTable.imposeConnections"),
        icon: Pin,
        onSelect: add ? () => add(agentPackageId) : undefined,
        disabled: !add,
        hidden: !agentActive,
        testId: `pin-impose-${integrationId}`,
      },
    ];
  }
  return [
    {
      id: "edit-pin",
      label: t("detail.connectionsTable.editImposed"),
      icon: Pencil,
      onSelect: edit ? () => edit(pin) : undefined,
      disabled: !edit,
      testId: `pin-edit-${integrationId}`,
    },
    {
      id: "remove-pin",
      label: t("detail.connectionsTable.removePin"),
      icon: PinOff,
      onSelect: () => remove(pin),
      destructive: true,
      testId: `pin-remove-${integrationId}`,
    },
  ];
}
