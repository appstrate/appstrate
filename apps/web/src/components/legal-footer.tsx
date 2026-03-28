import { useTranslation } from "react-i18next";
import { useAppConfig } from "../hooks/use-app-config";

export function LegalFooter() {
  const { t } = useTranslation("settings");
  const { legalUrls } = useAppConfig();

  if (!legalUrls) return null;

  return (
    <div className="text-balance text-center text-xs text-muted-foreground [&_a]:underline [&_a]:underline-offset-4 hover:[&_a]:text-primary">
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
