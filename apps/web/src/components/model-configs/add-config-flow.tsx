// SPDX-License-Identifier: Apache-2.0

/**
 * « Ajouter une configuration », start to end: the service (and a gateway's endpoint), then its
 * models with the recommended ones ticked, then the offer to connect it for the organization.
 * Every step can be left: a configuration with no connection is « À connecter », a valid state.
 */

import { useState } from "react";
import { useModelConfigs } from "../../hooks/use-model-configs";
import { useProvidersRegistry } from "../../hooks/use-model-provider-credentials";
import { usePermissions } from "../../hooks/use-permissions";
import { connectChoices } from "../../lib/model-configs";
import { CredentialFormModal } from "../credential-form-modal";
import { ModelChoiceDialog } from "../model-choice-dialog";
import { AddModelConfigDialog } from "./model-config-dialogs";

type Step =
  | { at: "service" }
  | { at: "models"; configId: string; tickNew: boolean }
  | { at: "connect"; configId: string };

export function AddConfigFlow({
  onClose,
  onFocus,
}: {
  onClose: () => void;
  /** The configuration the flow made or found: the host may open its row. */
  onFocus?: (configId: string) => void;
}) {
  const { can } = usePermissions();
  const { data: registry } = useProvidersRegistry();
  const { data: configs } = useModelConfigs();
  const [step, setStep] = useState<Step>({ at: "service" });

  if (!registry || !configs) return null;
  const config = step.at === "service" ? undefined : configs.find((c) => c.id === step.configId);

  if (step.at === "service") {
    return (
      <AddModelConfigDialog
        registry={registry}
        configs={configs}
        onClose={onClose}
        onCreated={(created) => {
          onFocus?.(created.id);
          setStep({ at: "models", configId: created.id, tickNew: true });
        }}
        onOpenExisting={(id) => {
          onFocus?.(id);
          onClose();
        }}
      />
    );
  }
  // The new configuration is read back after its creation: until then, nothing to draw.
  if (!config) return null;
  // The organization's first way to connect it: API keys first, as the server lists them.
  const [choice] = connectChoices(config, registry, {
    org: can("model-provider-credentials:write"),
    personal: false,
  });

  if (step.at === "models" || !choice) {
    return (
      <ModelChoiceDialog
        config={config}
        tickNew={step.at === "models" && step.tickNew}
        onClose={() =>
          choice && config.org_connection === "none"
            ? setStep({ at: "connect", configId: config.id })
            : onClose()
        }
      />
    );
  }

  return (
    <CredentialFormModal
      target={{ kind: "create", config, provider: choice.provider, ownerType: "org" }}
      onClose={onClose}
    />
  );
}
