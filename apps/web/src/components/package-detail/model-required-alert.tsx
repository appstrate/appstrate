// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import { useModels } from "../../hooks/use-models";
import { usePermissions } from "../../hooks/use-permissions";
import { isModelSelectable } from "../../lib/model-selectability";

/**
 * No model can run this agent. The remedy named is one the reader can perform:
 * configuring a model is `models:write` (`POST /api/models`), so anyone else is
 * pointed at an administrator rather than at a settings page they cannot edit.
 */
export function ModelRequiredAlert() {
  const { t } = useTranslation("settings");
  const { data: models } = useModels();
  const { can } = usePermissions();

  const hasAnyModel = models?.some((m) => m.is_default && isModelSelectable(m));
  if (hasAnyModel || hasAnyModel === undefined) return null;

  return (
    <Alert variant="destructive" className="mb-4">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{t("models.alert.noModel")}</AlertTitle>
      <AlertDescription className="flex items-center justify-between">
        <span>
          {t(
            can("models:write")
              ? "models.alert.noModelDescription"
              : "models.alert.noModelAskAdmin",
          )}
        </span>
      </AlertDescription>
    </Alert>
  );
}
