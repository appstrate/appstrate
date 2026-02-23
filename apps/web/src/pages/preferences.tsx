import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateLanguage, useUpdateDisplayName } from "../hooks/use-profile";
import { useAuth } from "../hooks/use-auth";
import { useServices } from "../hooks/use-services";
import { useConnect, useDisconnect, useConnectApiKey } from "../hooks/use-mutations";
import { ApiKeyModal } from "../components/api-key-modal";
import { formatDateField } from "../lib/markdown";
import { LoadingState, ErrorState } from "../components/page-states";

export function PreferencesPage() {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const updateLanguage = useUpdateLanguage();
  const [tab, setTab] = useState<"general" | "connectors">("general");

  return (
    <>
      <div className="page-header">
        <h2>{t("preferences.title")}</h2>
      </div>
      <div className="exec-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "general"}
          className={`tab ${tab === "general" ? "active" : ""}`}
          onClick={() => setTab("general")}
        >
          {t("preferences.tabGeneral")}
        </button>
        <button
          role="tab"
          aria-selected={tab === "connectors"}
          className={`tab ${tab === "connectors" ? "active" : ""}`}
          onClick={() => setTab("connectors")}
        >
          {t("preferences.tabConnectors")}
        </button>
      </div>

      {tab === "general" && (
        <GeneralTab
          language={i18n.language}
          onLanguageChange={(lng) => updateLanguage.mutate(lng)}
          languagePending={updateLanguage.isPending}
        />
      )}

      {tab === "connectors" && <ConnectorsTab />}
    </>
  );
}

function GeneralTab({
  language,
  onLanguageChange,
  languagePending,
}: {
  language: string;
  onLanguageChange: (lng: string) => void;
  languagePending: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <>
      <div className="section-title">{t("preferences.language")}</div>
      <div className="service-card" style={{ marginBottom: "1.5rem" }}>
        <div className="service-card-header" style={{ marginBottom: 0 }}>
          <div className="service-info">
            <select
              value={language}
              onChange={(e) => onLanguageChange(e.target.value)}
              disabled={languagePending}
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
      <DisplayNameForm />
      <PasswordChangeForm />

      <div className="section-title">{t("preferences.notifications")}</div>
      <div className="service-card">
        <div className="service-card-header" style={{ marginBottom: 0 }}>
          <div className="service-info">
            <span className="service-provider">{t("preferences.notificationsHint")}</span>
          </div>
        </div>
      </div>
    </>
  );
}

function DisplayNameForm() {
  const { t } = useTranslation(["settings", "common"]);
  const { profile } = useAuth();
  const updateDisplayName = useUpdateDisplayName();
  const [name, setName] = useState(profile?.displayName ?? "");
  const [success, setSuccess] = useState("");

  const isDirty = name.trim() !== (profile?.displayName ?? "");
  const canSubmit = name.trim().length > 0 && isDirty && !updateDisplayName.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSuccess("");
    updateDisplayName.mutate(name.trim(), {
      onSuccess: () => {
        setSuccess(t("preferences.displayNameChanged"));
        window.location.reload();
      },
    });
  };

  return (
    <div className="service-card" style={{ marginBottom: "1.5rem" }}>
      <form onSubmit={handleSubmit} style={{ padding: "0.25rem 0" }}>
        <div className="form-group">
          <label>{t("preferences.displayName")}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSuccess("");
            }}
            maxLength={100}
          />
        </div>
        {success && <div className="form-success">{success}</div>}
        <button type="submit" className="primary" disabled={!canSubmit}>
          {updateDisplayName.isPending
            ? t("preferences.savingDisplayName")
            : t("preferences.saveDisplayName")}
        </button>
      </form>
    </div>
  );
}

function PasswordChangeForm() {
  const { t } = useTranslation(["settings", "common"]);
  const { updatePassword } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (newPassword !== confirmPassword) {
      setError(t("preferences.passwordMismatch"));
      return;
    }

    setSubmitting(true);
    try {
      await updatePassword(currentPassword, newPassword);
      setSuccess(t("preferences.passwordChanged"));
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("login.error"));
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit =
    currentPassword.length > 0 &&
    newPassword.length >= 6 &&
    confirmPassword.length > 0 &&
    !submitting;

  return (
    <div className="service-card" style={{ marginBottom: "1.5rem" }}>
      <form onSubmit={handleSubmit} style={{ padding: "0.25rem 0" }}>
        <div className="form-group">
          <label>{t("preferences.currentPassword")}</label>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => {
              setCurrentPassword(e.target.value);
              setError("");
              setSuccess("");
            }}
            autoComplete="current-password"
          />
        </div>
        <div className="form-group">
          <label>{t("preferences.newPassword")}</label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
              setError("");
              setSuccess("");
            }}
            minLength={6}
            autoComplete="new-password"
          />
        </div>
        <div className="form-group">
          <label>{t("preferences.confirmPassword")}</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              setError("");
              setSuccess("");
            }}
            autoComplete="new-password"
          />
        </div>
        {error && <div className="form-error">{error}</div>}
        {success && <div className="form-success">{success}</div>}
        <button type="submit" className="primary" disabled={!canSubmit}>
          {submitting ? t("preferences.changingPassword") : t("preferences.changePassword")}
        </button>
      </form>
    </div>
  );
}

function ConnectorsTab() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: integrations, isLoading, error } = useServices();
  const connectMutation = useConnect();
  const disconnectMutation = useDisconnect();
  const apiKeyMutation = useConnectApiKey();

  const [apiKeyProvider, setApiKeyProvider] = useState<{
    uniqueKey: string;
    displayName: string;
  } | null>(null);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  if (!integrations || integrations.length === 0) {
    return (
      <div className="empty-state">
        <p>{t("services.empty")}</p>
        <p className="empty-hint">{t("services.emptyHint")}</p>
      </div>
    );
  }

  const handleConnect = (svc: { uniqueKey: string; displayName: string; authMode?: string }) => {
    if (svc.authMode === "API_KEY") {
      setApiKeyProvider({ uniqueKey: svc.uniqueKey, displayName: svc.displayName });
    } else {
      connectMutation.mutate(svc.uniqueKey);
    }
  };

  return (
    <>
      <div className="services-grid">
        {integrations.map((svc) => {
          const isConnected = svc.status === "connected";
          const connDate = svc.connectedAt ? formatDateField(svc.connectedAt) : "";

          return (
            <div key={svc.uniqueKey} className="service-card">
              <div className="service-card-header">
                {svc.logo && <img className="service-logo" src={svc.logo} alt={svc.displayName} />}
                <div className="service-info">
                  <h3>{svc.displayName}</h3>
                  <span className="service-provider">{svc.provider}</span>
                </div>
              </div>
              <div className="service-card-status">
                <span className={`status-dot ${isConnected ? "connected" : "disconnected"}`} />
                <span className={`badge ${isConnected ? "badge-success" : "badge-failed"}`}>
                  {isConnected ? t("services.connected") : t("services.notConnected")}
                </span>
                {connDate && <span className="service-date">{connDate}</span>}
              </div>
              <div className="service-card-actions">
                {isConnected ? (
                  <>
                    <button
                      onClick={() => {
                        if (confirm(t("services.disconnectConfirm", { name: svc.uniqueKey }))) {
                          disconnectMutation.mutate(svc.uniqueKey);
                        }
                      }}
                      disabled={disconnectMutation.isPending}
                    >
                      {t("btn.disconnect", { ns: "common" })}
                    </button>
                    <button
                      onClick={() => handleConnect(svc)}
                      disabled={connectMutation.isPending || apiKeyMutation.isPending}
                    >
                      {t("btn.reconnect", { ns: "common" })}
                    </button>
                  </>
                ) : (
                  <button
                    className="primary"
                    onClick={() => handleConnect(svc)}
                    disabled={connectMutation.isPending || apiKeyMutation.isPending}
                  >
                    {t("btn.connect", { ns: "common" })}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <ApiKeyModal
        open={!!apiKeyProvider}
        onClose={() => setApiKeyProvider(null)}
        providerName={apiKeyProvider?.displayName ?? ""}
        isPending={apiKeyMutation.isPending}
        onSubmit={(apiKey) => {
          if (apiKeyProvider) {
            apiKeyMutation.mutate(
              { provider: apiKeyProvider.uniqueKey, apiKey },
              { onSuccess: () => setApiKeyProvider(null) },
            );
          }
        }}
      />
    </>
  );
}
