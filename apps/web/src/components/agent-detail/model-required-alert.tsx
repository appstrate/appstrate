// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import { usePermissions } from "../../hooks/use-permissions";
import type { useAgentModelBlocker } from "../../hooks/use-agent-readiness";

const MODEL_ALERT_COPY = {
  "detail.titleModel": {
    title: "models.alert.noModel",
    description: "models.alert.noModelDescription",
    askAdmin: "models.alert.noModelAskAdmin",
  },
  "detail.titleNoDefaultModel": {
    title: "models.alert.noDefaultModel",
    description: "models.alert.noDefaultModelDescription",
    askAdmin: "models.alert.noDefaultModelAskAdmin",
  },
} as const;

/** No model a run could use: said where it can be acted on, graded by who may act. */
export function ModelRequiredAlert({
  blocker,
}: {
  blocker: ReturnType<typeof useAgentModelBlocker>;
}) {
  const { t } = useTranslation(["settings"]);
  const { can } = usePermissions();

  const copy = blocker && MODEL_ALERT_COPY[blocker];
  if (!copy) return null;

  return (
    <Alert variant="destructive" className="mb-4">
      <AlertTitle>{t(copy.title)}</AlertTitle>
      {/* Only `models:write` can act on it (POST /api/models, PUT /api/models/default). */}
      <AlertDescription>
        {t(can("models:write") ? copy.description : copy.askAdmin)}
      </AlertDescription>
    </Alert>
  );
}
