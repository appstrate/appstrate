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
import { $api } from "../../api/client";
import { Modal } from "../modal";
import {
  useAgentsConsumingIntegration,
  type IntegrationManifestView,
} from "../../hooks/use-integrations";
import { useOrgScope } from "../../hooks/use-org-scope";
import { usePermissions } from "../../hooks/use-permissions";
import { splitPackageRef } from "../../lib/package-paths";
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
  const { openPopup, isPending } = useHostedConnectPopup();
  const formId = `connect-scopes-${target.authKey}`;

  const connect = (scopes: string[]) => {
    setOpen(false);
    // Called from the submit click, so the popup opens inside the user gesture.
    void openPopup({
      packageId: target.packageId,
      authKey: target.authKey,
      ...(scopes.length > 0 ? { scopes } : {}),
      ...(forceAccountSelect ? { forceAccountSelect: true } : {}),
    });
  };

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
            <Button type="submit" form={formId} data-testid={`${formId}-submit`}>
              {t("agents:detail.integrationConnect")}
            </Button>
          </>
        }
      >
        <ConnectScopesForm formId={formId} onSubmit={connect} {...target} />
      </Modal>
    </>
  );
}

export function ConnectScopesForm({
  formId,
  onSubmit,
  ...target
}: ScopeTarget & { formId: string; onSubmit: (scopes: string[]) => void }) {
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
        onSubmit(requested);
      }}
    >
      <p className="text-muted-foreground text-xs">{t("integration.auth.scopeChoice.help")}</p>
      <AgentQuickFill
        {...target}
        onScopes={(scopes) => setTicked((prev) => [...new Set([...prev, ...scopes])])}
      />
      {choice.baseline.length > 0 && (
        <p className="text-xs" data-testid={`${formId}-baseline`}>
          {t("integration.auth.scopeChoice.baseline", {
            scopes: scopeLabels(target.manifest, target.authKey, choice.baseline).join(", "),
          })}
        </p>
      )}
      <div className="space-y-2">
        <Label className="text-xs">{t("integration.auth.scopeChoice.extra")}</Label>
        {choice.selectable.map((entry) => {
          const id = `${formId}-${entry.value}`;
          return (
            <div key={entry.value} className="flex items-start gap-2 text-xs">
              <Checkbox
                id={id}
                checked={requested.includes(entry.value)}
                onCheckedChange={() => toggle(entry.value)}
                data-testid={id}
              />
              <label htmlFor={id} className="min-w-0" title={entry.value}>
                {entry.label}
                {entry.description && (
                  <span className="text-muted-foreground block">{entry.description}</span>
                )}
              </label>
            </div>
          );
        })}
        {requested.length === 0 && (
          <p className="text-muted-foreground text-xs" data-testid={`${formId}-defaults-only`}>
            {t("integration.auth.scopeChoice.defaultsOnly")}
          </p>
        )}
      </div>
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
  onScopes,
}: ScopeTarget & { onScopes: (scopes: string[]) => void }) {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const scope = useOrgScope();
  const { can } = usePermissions();
  const { data: agents } = useAgentsConsumingIntegration(packageId);
  const [applied, setApplied] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  if (!packageSightPermissions("agent").some(can) || !agents || agents.length === 0) return null;

  const apply = async (agentId: string) => {
    const agent = agents.find((a) => a.agent_package_id === agentId);
    if (!agent) return;
    setLoading(true);
    try {
      const detail = await qc.fetchQuery(
        $api.queryOptions("get", "/api/packages/agents/{scope}/{name}", {
          params: { path: splitPackageRef(agentId), header: scope.header },
        }),
      );
      const entry = detail.dependencies.integrations.find((i) => i.id === packageId);
      onScopes(entry ? scopesForAgent(choice, { manifest, authKey, agent: entry }) : []);
      setApplied((prev) =>
        prev.includes(agent.display_name) ? prev : [...prev, agent.display_name],
      );
    } catch (err) {
      toastError(err);
    } finally {
      setLoading(false);
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
      {applied.length > 0 && (
        <p className="text-muted-foreground text-xs">
          {t("integration.auth.scopeChoice.forAgentApplied", { agents: applied.join(", ") })}
        </p>
      )}
    </div>
  );
}
