// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Label } from "@appstrate/ui/components/label";
import { Modal } from "../modal";
import { useHostedConnectPopup } from "../integration-connect/use-integration-oauth-popup";
import { scopeLabels } from "../integration-connect/connection-scope-fit";
import { useModalParam } from "../../hooks/use-modal-param";
import { connectPopupInput, type ScopeTarget } from "./connect-scope-choice";
import { AgentQuickFill } from "./agent-quick-fill";

/** The modal parameter of {@link ConnectScopesModal}: its value is the auth key. */
export const CONNECT_SCOPES_PARAM = "connectScopes";

/**
 * The scopes "+ Ajouter" asks for on an auth with a `scope_catalog`, before the consent screen.
 * Its URL is `?connectScopes=<authKey>`; the caller opens it with the same parameter and
 * connects at once, with the defaults, on an auth that has nothing to choose.
 */
export function ConnectScopesModal({
  forceAccountSelect,
  ...target
}: ScopeTarget & { forceAccountSelect: boolean }) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const modal = useModalParam(CONNECT_SCOPES_PARAM);
  const { openPopup } = useHostedConnectPopup();
  const formId = `connect-scopes-${target.authKey}`;

  return (
    <Modal
      open={modal.value === target.authKey}
      onClose={modal.close}
      title={t("integration.auth.scopeChoice.title")}
      actions={
        <>
          <Button variant="outline" type="button" onClick={modal.close}>
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
          modal.close();
          // Called from a submit, so the popup opens inside the user gesture.
          void openPopup(connectPopupInput(target, ticked, forceAccountSelect));
        }}
        {...target}
      />
    </Modal>
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
