// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plug } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Label } from "@appstrate/ui/components/label";
import { Modal } from "../modal";
import { useHostedConnectPopup } from "../integration-connect/use-integration-oauth-popup";
import { scopeLabels } from "../integration-connect/connection-scope-fit";
import { connectPopupInput, type ScopeChoice, type ScopeTarget } from "./connect-scope-choice";
import { AgentQuickFill } from "./agent-quick-fill";

/**
 * "+ Ajouter" of one auth. With scopes to choose (oauth2 with a `scope_catalog`) it asks for
 * them before consent; otherwise it connects at once with the defaults.
 */
export function AddAccountButton({
  label,
  forceAccountSelect,
  choice,
  ...target
}: Omit<ScopeTarget, "choice"> & {
  choice: ScopeChoice | null;
  label: string;
  forceAccountSelect: boolean;
}) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const [open, setOpen] = useState(false);
  const { openPopup, isPending } = useHostedConnectPopup();
  const formId = `connect-scopes-${target.authKey}`;
  // Always called from a click, so the popup opens inside the user gesture.
  const connect = (ticked: string[]) =>
    void openPopup(connectPopupInput({ ...target, choice }, ticked, forceAccountSelect));

  return (
    <>
      <Button
        size="sm"
        onClick={() => (choice ? setOpen(true) : connect([]))}
        disabled={isPending}
        data-testid={`add-account-${target.authKey}`}
      >
        <Plug className="mr-1 size-3" />
        {label}
      </Button>
      {choice && (
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
          <ConnectScopesForm
            formId={formId}
            onSubmit={(ticked) => {
              setOpen(false);
              connect(ticked);
            }}
            choice={choice}
            {...target}
          />
        </Modal>
      )}
    </>
  );
}

export function ConnectScopesForm({
  formId,
  onSubmit,
  ...target
}: ScopeTarget & { formId: string; onSubmit: (ticked: string[]) => void }) {
  const { t } = useTranslation("settings");
  const [ticked, setTicked] = useState<string[]>([]);
  const { choice } = target;
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
        onAdd={(scopes) =>
          setTicked((prev) => [...prev, ...scopes.filter((s) => !prev.includes(s))])
        }
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
                checked={ticked.includes(entry.value)}
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
        {ticked.length === 0 && (
          <p className="text-muted-foreground text-xs" data-testid={`${formId}-defaults-only`}>
            {t("integration.auth.scopeChoice.defaultsOnly")}
          </p>
        )}
      </fieldset>
    </form>
  );
}
