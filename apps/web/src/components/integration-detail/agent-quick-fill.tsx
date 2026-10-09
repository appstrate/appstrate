// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { packageSightPermissions } from "@appstrate/core/permissions";
import type { ConsumingAgentSummary } from "@appstrate/shared-types";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { useAgentsConsumingIntegration } from "../../hooks/use-integrations";
import { packageDetailQueryOptions } from "../../hooks/use-packages";
import { useCurrentOrgId } from "../../hooks/use-org";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { usePermissions } from "../../hooks/use-permissions";
import { errorMessage, toastError } from "../../lib/mutation-error";
import { agentScopes, type ScopeTarget } from "./connect-scope-choice";

type PickState = "idle" | "picking" | "nothing";

/**
 * Ticks the scopes an agent of the space needs on this auth, read from its
 * `integrations_configuration`. The agent only fills the checklist: the
 * connection is not pinned to it. Repeated picks add up.
 */
export function AgentQuickFill({
  ticked,
  onAdd,
  ...target
}: ScopeTarget & { ticked: string[]; onAdd: (scopes: string[]) => void }) {
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const { can } = usePermissions();
  const canSeeAgents = packageSightPermissions("agent").some(can);
  const list = useAgentsConsumingIntegration(canSeeAgents ? target.packageId : undefined);
  const [state, setState] = useState<PickState>("idle");

  const pick = async (agentId: string) => {
    setState("picking");
    try {
      const agent = await qc.ensureQueryData(
        packageDetailQueryOptions("agent", { orgId, spaceId }, agentId),
      );
      const entry = agent.dependencies.integrations.find((i) => i.id === target.packageId);
      const scopes = entry
        ? agentScopes(target.choice, target.manifest, target.authKey, entry)
        : [];
      onAdd(scopes);
      setState(scopes.every((s) => ticked.includes(s)) ? "nothing" : "idle");
    } catch (err) {
      setState("idle");
      toastError(err);
    }
  };

  return (
    <AgentQuickFillMenu
      authKey={target.authKey}
      list={list}
      state={state}
      onPick={(id) => void pick(id)}
    />
  );
}

/** The quick-fill's view: an action menu of the space's agents declaring the integration. */
export function AgentQuickFillMenu({
  authKey,
  list,
  state,
  onPick,
}: {
  authKey: string;
  list: { data?: readonly ConsumingAgentSummary[]; isLoading: boolean; error: unknown };
  state: PickState;
  onPick: (agentId: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const agents = list.data ?? [];
  if (!list.isLoading && !list.error && agents.length === 0) return null;
  const id = `connect-scopes-agent-${authKey}`;

  return (
    <div className="space-y-1">
      <p id={`${id}-heading`} className="text-xs font-medium">
        {t("integration.auth.scopeChoice.forAgent")}
      </p>
      {list.isLoading ? (
        <p className="text-muted-foreground text-xs">{t("common:loading")}</p>
      ) : list.error ? (
        <p className="text-destructive text-xs" data-testid={`${id}-error`}>
          {errorMessage(list.error)}
        </p>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={state === "picking"}
              aria-describedby={`${id}-heading`}
              data-testid={id}
            >
              {t("integration.auth.scopeChoice.forAgentPlaceholder")}
              <ChevronDown className="ml-1 size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {agents.map((a) => (
              <DropdownMenuItem
                key={a.agent_package_id}
                onSelect={() => onPick(a.agent_package_id)}
              >
                {a.display_name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {state === "nothing" && (
        <p className="text-muted-foreground text-xs" role="status" data-testid={`${id}-nothing`}>
          {t("integration.auth.scopeChoice.nothingToAdd")}
        </p>
      )}
    </div>
  );
}
