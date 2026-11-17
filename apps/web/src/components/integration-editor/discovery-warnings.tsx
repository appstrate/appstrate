// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";

/** The caveats an analysis or a server sync reported, in the user's language. */
export function DiscoveryWarnings({
  warnings,
}: {
  warnings: ReadonlyArray<{ code: string; message: string }>;
}) {
  const { t } = useTranslation("agents");
  return warnings.map((warning) => (
    <Alert key={warning.code} variant="warning">
      <AlertDescription>
        {t(`integrationEditor.discover.warning.${warning.code}`, {
          defaultValue: warning.message,
        })}
      </AlertDescription>
    </Alert>
  ));
}
