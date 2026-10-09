// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Plug } from "lucide-react";
import { packageSightPermissions } from "@appstrate/core/permissions";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Label } from "@appstrate/ui/components/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import type { ConsumingAgentSummary } from "@appstrate/shared-types";
import { Modal } from "../modal";
import { useAgentsConsumingIntegration } from "../../hooks/use-integrations";
import { packageDetailQueryOptions } from "../../hooks/use-packages";
import { useCurrentOrgId } from "../../hooks/use-org";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { usePermissions } from "../../hooks/use-permissions";
import { errorMessage, toastError } from "../../lib/mutation-error";
import { scopeLabels } from "../integration-connect/connection-scope-fit";
import { requestedScopes, tickAgentScopes } from "./connect-scope-choice";
import { useConnectWithScopes, type ScopeTarget } from "./use-connect-with-scopes";

/**
 * "+ Ajouter" for an oauth2 auth that declares a `scope_catalog`: the scopes are
 * chosen before consent, then the hosted connect popup runs with them.
 */
export function ConnectWithScopesButton({
  label,
  forceAccountSelect,
  ...target
}: ScopeTarget & { label: string; forceAccountSelect: boolean }) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const [open, setOpen] = useState(false);
  const [agentLoading, setAgentLoading] = useState(false);
  const { connect, isPending } = useConnectWithScopes({ ...target, forceAccountSelect });
  const formId = `connect-scopes-${target.authKey}`;

  return (
    <>
      <Button
        size="sm"
        onClick={() => setOpen(true)}
        disabled={isPending}
        data-testid={`connect-scopes-open-${target.authKey}`}
      >
        <Plug className="mr-1 size-3" />
        {label}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("integration.auth.scopeChoice.title")}
        actions={
          <>
            <Button variant="outline" type="button" onClick={() => setOpen(false)}>
              {t("common:btn.cancel")}
            </Button>
            <Button
              type="submit"
              form={formId}
              disabled={agentLoading}
              data-testid={`${formId}-submit`}
            >
              {t("agents:detail.integrationConnect")}
            </Button>
          </>
        }
      >
        <ConnectScopesForm
          formId={formId}
          agentLoading={agentLoading}
          onAgentLoading={setAgentLoading}
          onSubmit={(ticked) => {
            setOpen(false);
            // Called from the submit click, so the popup opens inside the user gesture.
            void connect(ticked);
          }}
          {...target}
        />
      </Modal>
    </>
  );
}

export function ConnectScopesForm({
  formId,
  agentLoading,
  onAgentLoading,
  onSubmit,
  ...target
}: ScopeTarget & {
  formId: string;
  agentLoading: boolean;
  onAgentLoading: (loading: boolean) => void;
  onSubmit: (ticked: string[]) => void;
}) {
  const { t } = useTranslation("settings");
  const [ticked, setTicked] = useState<string[]>([]);
  const { choice } = target;
  const requested = requestedScopes(choice, ticked);

  const toggle = (value: string) =>
    setTicked((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );

  return (
    <form
      id={formId}
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(ticked);
      }}
    >
      <p className="text-muted-foreground text-xs">{t("integration.auth.scopeChoice.help")}</p>
      <AgentQuickFill
        {...target}
        ticked={ticked}
        onTicked={setTicked}
        loading={agentLoading}
        onLoading={onAgentLoading}
      />
      {choice.baseline.length > 0 && (
        <p className="text-xs" data-testid={`${formId}-baseline`}>
          {t("integration.auth.scopeChoice.baseline", {
            scopes: scopeLabels(target.manifest, target.authKey, choice.baseline).join(", "),
          })}
        </p>
      )}
      {/* Frozen while an agent's scopes load: the pick merges into the ticks it started from. */}
      <fieldset className="min-w-0 space-y-2" disabled={agentLoading}>
        <legend className="mb-2 text-xs font-medium">
          {t("integration.auth.scopeChoice.extra")}
        </legend>
        {choice.selectable.map((entry) => {
          const id = `${formId}-${entry.value}`;
          return (
            <div key={entry.value} className="flex items-start gap-2">
              <Checkbox
                id={id}
                checked={requested.includes(entry.value)}
                onCheckedChange={() => toggle(entry.value)}
                data-testid={id}
              />
              <Label htmlFor={id} className="min-w-0 text-xs font-normal" title={entry.value}>
                {entry.label}
                {entry.description && (
                  <span className="text-muted-foreground mt-1 block">{entry.description}</span>
                )}
              </Label>
            </div>
          );
        })}
        {requested.length === 0 && (
          <p className="text-muted-foreground text-xs" data-testid={`${formId}-defaults-only`}>
            {t("integration.auth.scopeChoice.defaultsOnly")}
          </p>
        )}
      </fieldset>
    </form>
  );
}

/**
 * Ticks the scopes an agent of the space needs on this auth, read from its
 * `integrations_configuration`. The agent only fills the checklist: the
 * connection is not pinned to it. Repeated picks add up.
 */
function AgentQuickFill({
  ticked,
  onTicked,
  loading,
  onLoading,
  ...target
}: ScopeTarget & {
  ticked: string[];
  onTicked: (ticked: string[]) => void;
  loading: boolean;
  onLoading: (loading: boolean) => void;
}) {
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const { can } = usePermissions();
  const { data: agents, isLoading, error } = useAgentsConsumingIntegration(target.packageId);
  const [nothingToAdd, setNothingToAdd] = useState(false);

  if (!packageSightPermissions("agent").some(can)) return null;

  const pick = async (agentId: string) => {
    setNothingToAdd(false);
    onLoading(true);
    try {
      const result = await tickAgentScopes({
        loadAgent: () =>
          qc.fetchQuery(packageDetailQueryOptions("agent", { orgId, spaceId }, agentId)),
        integrationId: target.packageId,
        manifest: target.manifest,
        authKey: target.authKey,
        choice: target.choice,
        ticked,
      });
      onTicked(result.ticked);
      setNothingToAdd(!result.added);
    } catch (err) {
      toastError(err);
    } finally {
      onLoading(false);
    }
  };

  return (
    <AgentQuickFillMenu
      authKey={target.authKey}
      agents={agents ?? []}
      listLoading={isLoading}
      listError={error}
      picking={loading}
      nothingToAdd={nothingToAdd}
      onPick={(agentId) => void pick(agentId)}
    />
  );
}

/** The quick-fill's view: an action menu of the space's agents declaring the integration. */
export function AgentQuickFillMenu({
  authKey,
  agents,
  listLoading,
  listError,
  picking,
  nothingToAdd,
  onPick,
}: {
  authKey: string;
  agents: readonly ConsumingAgentSummary[];
  listLoading: boolean;
  listError: unknown;
  picking: boolean;
  nothingToAdd: boolean;
  onPick: (agentId: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  if (!listLoading && !listError && agents.length === 0) return null;
  const id = `connect-scopes-agent-${authKey}`;

  return (
    <div className="space-y-1">
      <p id={`${id}-heading`} className="text-xs font-medium">
        {t("integration.auth.scopeChoice.forAgent")}
      </p>
      {listLoading ? (
        <p className="text-muted-foreground text-xs">{t("common:loading")}</p>
      ) : listError ? (
        <p className="text-destructive text-xs" data-testid={`${id}-error`}>
          {errorMessage(listError)}
        </p>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={picking}
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
      {nothingToAdd && (
        <p className="text-muted-foreground text-xs" role="status" data-testid={`${id}-nothing`}>
          {t("integration.auth.scopeChoice.nothingToAdd")}
        </p>
      )}
    </div>
  );
}
