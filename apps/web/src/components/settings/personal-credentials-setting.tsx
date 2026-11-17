// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { OrgSettingToggle } from "./org-setting-toggle";
import { invalidateCredentialsAndModels } from "../../hooks/use-model-provider-credentials";

export function PersonalCredentialsSetting() {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  return (
    <OrgSettingToggle
      id="personal-model-credentials"
      field="personal_model_credentials"
      label={t("orgSettings.personalModelCredentialsTitle")}
      description={t("orgSettings.personalModelCredentialsDesc")}
      // The flag changes which models and credentials serve a call: refresh both lists.
      onSuccess={() => void invalidateCredentialsAndModels(queryClient)}
    />
  );
}
