// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { usePackageActivation } from "../hooks/use-library";

/** Switches a declared integration on in this space; dead, with the reason, for a caller the route would refuse. */
export function ActivateIntegrationButton({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["agents", "common"]);
  const { mayActivate, activate, pending } = usePackageActivation("integration", packageId);
  return (
    <Button
      size="sm"
      variant="outline"
      pending={pending}
      disabled={!mayActivate}
      title={mayActivate ? undefined : t("library.cannotActivate", { ns: "common" })}
      onClick={() => activate()}
      data-testid={`integration-activate-${packageId}`}
    >
      {t("editor.activateIntegration")}
    </Button>
  );
}
