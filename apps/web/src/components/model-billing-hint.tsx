// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { OrgModelInfo } from "../hooks/use-models";

/**
 * Who pays for a model, for the caller, as a muted note beside its name in a
 * picker. Renders nothing for an organization credential: that is the common
 * case, and naming it on every row would be noise. `null` means no usable
 * credential exists for the caller, so the run or chat is refused until one is
 * added.
 */
export function ModelBillingHint({ billedTo }: { billedTo: OrgModelInfo["billed_to"] }) {
  const { t } = useTranslation("settings");
  if (billedTo === "user") {
    return (
      <span className="text-muted-foreground text-xs">{t("models.billing.userCredential")}</span>
    );
  }
  if (billedTo === null) {
    return (
      <span className="text-muted-foreground text-xs">
        {t("models.billing.credentialRequired")}
      </span>
    );
  }
  return null;
}
