// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import { usePermissions } from "../../hooks/use-permissions";
import type { useAgentModelBlocker } from "../../hooks/use-agent-readiness";

/** Only `models:write` can act on either blocker (POST /api/models, PUT /api/models/default), so the others are told to ask. */
const COPY = {
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
  if (!blocker) return null;
  const copy = COPY[blocker];

  return (
    <Alert variant="destructive" className="mb-4">
      <TriangleAlert className="size-4" />
      <AlertTitle>{t(copy.title)}</AlertTitle>
      <AlertDescription className="flex items-center justify-between">
        <span>{t(can("models:write") ? copy.description : copy.askAdmin)}</span>
      </AlertDescription>
    </Alert>
  );
}
