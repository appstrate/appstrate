// SPDX-License-Identifier: Apache-2.0

/**
 * « Ajouter une configuration », start to end: the service (and a gateway's endpoint), then its
 * models with the recommended ones ticked, then the offer to connect it for the organization.
 * Every step can be left: a configuration with no connection is « À connecter », a valid state.
 *
 * The configuration the first step creates is held here, not read back from the list: the next
 * dialog opens on the server's answer, whatever the list refetch does.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useModelConfigs } from "../../hooks/use-model-configs";
import { useProvidersRegistry } from "../../hooks/use-model-provider-credentials";
import { usePermissions } from "../../hooks/use-permissions";
import { connectChoices, type ConnectChoice, type ModelConfigInfo } from "../../lib/model-configs";
import { CredentialFormModal } from "../credential-form-modal";
import { TextSkeleton } from "../loading-skeletons";
import { Modal } from "../modal";
import { ModelChoiceDialog } from "../model-choice-dialog";
import { ErrorState } from "../page-states";
import { AddModelConfigDialog } from "./model-config-dialogs";

type Step =
  | { at: "service" }
  | { at: "models"; config: ModelConfigInfo; tickNew: boolean }
  | { at: "connect"; config: ModelConfigInfo; choice: ConnectChoice };

export function AddConfigFlow({
  onClose,
  onFocus,
}: {
  onClose: () => void;
  /** The configuration the flow made or found: the host may open its row. */
  onFocus?: (configId: string) => void;
}) {
  const { t } = useTranslation("settings");
  const { can } = usePermissions();
  const registryQuery = useProvidersRegistry();
  const configsQuery = useModelConfigs();
  const [step, setStep] = useState<Step>({ at: "service" });
  const registry = registryQuery.data;
  const configs = configsQuery.data;

  if (step.at === "service") {
    if (!registry || !configs) {
      // The lists the first step draws are not there yet (the onboarding opens it cold).
      const error = registryQuery.error ?? configsQuery.error;
      return (
        <Modal onClose={onClose} title={t("modelConfigs.add.title")}>
          {error ? (
            <ErrorState error={error} compact />
          ) : (
            <TextSkeleton lines={3} className="py-2" />
          )}
        </Modal>
      );
    }
    return (
      <AddModelConfigDialog
        registry={registry}
        configs={configs}
        onClose={onClose}
        onCreated={(created) => {
          onFocus?.(created.id);
          setStep({ at: "models", config: created, tickNew: true });
        }}
        onOpenExisting={(id) => {
          onFocus?.(id);
          onClose();
        }}
      />
    );
  }

  if (step.at === "models") {
    const { config } = step;
    return (
      <ModelChoiceDialog
        config={config}
        tickNew={step.tickNew}
        // Leaving without saving leaves the flow: only a save goes on to the connection.
        onClose={onClose}
        onSaved={() => {
          // The organization's first way to connect it: API keys first, as the server lists them.
          const [choice] = connectChoices(
            config,
            registry ?? [],
            { org: can("model-provider-credentials:write"), personal: false },
            [],
          );
          if (choice && config.org_connection === "none")
            setStep({ at: "connect", config, choice });
          else onClose();
        }}
      />
    );
  }

  return (
    <CredentialFormModal
      target={{
        kind: "create",
        config: step.config,
        provider: step.choice.provider,
        ownerType: "org",
      }}
      onClose={onClose}
    />
  );
}
