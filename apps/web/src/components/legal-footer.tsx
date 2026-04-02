// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useAppConfig } from "../hooks/use-app-config";

export function LegalFooter() {
  const { t } = useTranslation("settings");
  const { legalUrls } = useAppConfig();

  if (!legalUrls) return null;

  return (
    <div className="text-muted-foreground hover:[&_a]:text-primary text-center text-xs text-balance [&_a]:underline [&_a]:underline-offset-4">
      {t("login.termsNotice")}{" "}
      {legalUrls.terms && (
        <a href={legalUrls.terms} target="_blank" rel="noopener noreferrer">
          {t("login.termsOfService")}
        </a>
      )}
      {legalUrls.terms && legalUrls.privacy && ` ${t("login.and")} `}
      {legalUrls.privacy && (
        <a href={legalUrls.privacy} target="_blank" rel="noopener noreferrer">
          {t("login.privacyPolicy")}
        </a>
      )}
      .
    </div>
  );
}
