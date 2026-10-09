// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import { packageSightPermissions } from "@appstrate/core/permissions";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { Modal } from "../modal";
import {
  useAgentsConsumingIntegration,
  type IntegrationManifestView,
} from "../../hooks/use-integrations";
import { packageDetailQueryOptions } from "../../hooks/use-packages";
import { useCurrentOrgId } from "../../hooks/use-org";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { usePermissions } from "../../hooks/use-permissions";
import { toastError } from "../../lib/mutation-error";
import { useHostedConnectPopup } from "../integration-connect/use-integration-oauth-popup";
import { scopeLabels } from "../integration-connect/connection-scope-fit";
import { requestedScopes, scopesForAgent, type ScopeChoice } from "./connect-scope-choice";

interface ScopeTarget {
  packageId: string;
  authKey: string;
  manifest: IntegrationManifestView;
  choice: ScopeChoice;
}

/** Tests pass an `openPopup`: the real one needs a browser. */
export interface ConnectWithScopesDeps {
  openPopup?: ReturnType<typeof useHostedConnectPopup>["openPopup"];
}

/** Starts the hosted connect with the ticked scopes in catalog order; none for the baseline. */
export function useConnectWithScopes(
  target: ScopeTarget & { forceAccountSelect: boolean },
  deps: ConnectWithScopesDeps = {},
) {
  const hosted = useHostedConnectPopup();
  const openPopup = deps.openPopup ?? hosted.openPopup;
  const connect = (ticked: readonly string[]) => {
    const scopes = requestedScopes(target.choice, ticked);
    return openPopup({
      packageId: target.packageId,
      authKey: target.authKey,
      ...(scopes.length > 0 ? { scopes } : {}),
      ...(target.forceAccountSelect ? { forceAccountSelect: true } : {}),
    });
  };
  return { connect, isPending: hosted.isPending };
}

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
        loading={agentLoading}
        onLoading={onAgentLoading}
        onScopes={(scopes) => setTicked((prev) => [...new Set([...prev, ...scopes])])}
      />
      {choice.baseline.length > 0 && (
        <p className="text-xs" data-testid={`${formId}-baseline`}>
          {t("integration.auth.scopeChoice.baseline", {
            scopes: scopeLabels(target.manifest, target.authKey, choice.baseline).join(", "),
          })}
        </p>
      )}
      <fieldset className="min-w-0 space-y-2">
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
  packageId,
  authKey,
  manifest,
  choice,
  loading,
  onLoading,
  onScopes,
}: ScopeTarget & {
  loading: boolean;
  onLoading: (loading: boolean) => void;
  onScopes: (scopes: string[]) => void;
}) {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const { can } = usePermissions();
  const { data: agents } = useAgentsConsumingIntegration(packageId);

  if (!packageSightPermissions("agent").some(can) || !agents || agents.length === 0) return null;

  const apply = async (agentId: string) => {
    onLoading(true);
    try {
      const detail = await qc.fetchQuery(
        packageDetailQueryOptions("agent", { orgId, spaceId }, agentId),
      );
      const entry = detail.dependencies.integrations.find((i) => i.id === packageId);
      onScopes(entry ? scopesForAgent(choice, { manifest, authKey, agent: entry }) : []);
    } catch (err) {
      toastError(err);
    } finally {
      onLoading(false);
    }
  };

  const selectId = `connect-scopes-agent-${authKey}`;
  return (
    <div className="space-y-1">
      <Label htmlFor={selectId} className="text-xs">
        {t("integration.auth.scopeChoice.forAgent")}
      </Label>
      {/* Always back on the placeholder: a pick is an action, not a value. */}
      <Select value="" disabled={loading} onValueChange={(id) => void apply(id)}>
        <SelectTrigger id={selectId} className="w-full" data-testid={selectId}>
          <SelectValue placeholder={t("integration.auth.scopeChoice.forAgentPlaceholder")} />
        </SelectTrigger>
        <SelectContent>
          {agents.map((a) => (
            <SelectItem key={a.agent_package_id} value={a.agent_package_id}>
              {a.display_name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
