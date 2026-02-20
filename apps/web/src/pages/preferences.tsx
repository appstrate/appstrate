import { useTranslation } from "react-i18next";
import { useUpdateLanguage } from "../hooks/use-profile";

export function PreferencesPage() {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const updateLanguage = useUpdateLanguage();

  const handleLanguageChange = (lng: string) => {
    updateLanguage.mutate(lng);
  };

  return (
    <div className="preferences-page">
      <div className="page-header">
        <h2>{t("preferences.title")}</h2>
      </div>

      <div className="section-title">{t("preferences.language")}</div>
      <div className="service-card" style={{ marginBottom: "1.5rem" }}>
        <div className="service-card-header" style={{ marginBottom: 0 }}>
          <div className="service-info">
            <select
              value={i18n.language}
              onChange={(e) => handleLanguageChange(e.target.value)}
              disabled={updateLanguage.isPending}
              style={{
                padding: "0.5rem 0.75rem",
                fontSize: "0.875rem",
                fontFamily: "inherit",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                color: "var(--text)",
                outline: "none",
                cursor: "pointer",
              }}
            >
              <option value="fr">{t("preferences.langFr")}</option>
              <option value="en">{t("preferences.langEn")}</option>
            </select>
          </div>
        </div>
      </div>

      <div className="section-title">{t("preferences.account")}</div>
      <div className="service-card" style={{ marginBottom: "1.5rem" }}>
        <div className="service-card-header" style={{ marginBottom: 0 }}>
          <div className="service-info">
            <span className="service-provider">{t("preferences.accountHint")}</span>
          </div>
        </div>
      </div>

      <div className="section-title">{t("preferences.notifications")}</div>
      <div className="service-card">
        <div className="service-card-header" style={{ marginBottom: 0 }}>
          <div className="service-info">
            <span className="service-provider">{t("preferences.notificationsHint")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
