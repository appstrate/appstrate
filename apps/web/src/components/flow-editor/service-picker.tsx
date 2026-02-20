import { useTranslation } from "react-i18next";
import { useServices } from "../../hooks/use-services";
import { SchemaSection } from "./schema-section";
import type { SchemaField } from "./schema-section";
import type { ServiceEntry } from "./types";

interface ServicePickerProps {
  value: ServiceEntry[];
  onChange: (value: ServiceEntry[]) => void;
}

export function ServicePicker({ value, onChange }: ServicePickerProps) {
  const { t } = useTranslation(["flows", "common"]);
  const { data: integrations, isLoading } = useServices();

  const update = (index: number, patch: Partial<ServiceEntry>) => {
    const next = value.map((s, i) => (i === index ? { ...s, ...patch } : s));
    onChange(next);
  };

  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  const addFromIntegration = (uniqueKey: string, provider: string) => {
    const alreadySelected = value.some((s) => s.id === uniqueKey);
    if (alreadySelected) return;
    onChange([
      ...value,
      {
        id: uniqueKey,
        provider,
        description: "",
        scopes: "",
        connectionMode: "user",
        credentialSchema: [],
        authorizedUris: "",
        allowAllUris: false,
      },
    ]);
  };

  const addCustomService = () => {
    onChange([
      ...value,
      {
        id: "",
        provider: "custom",
        description: "",
        scopes: "",
        connectionMode: "user",
        credentialSchema: [],
        authorizedUris: "",
        allowAllUris: false,
      },
    ]);
  };

  const selectedIds = new Set(value.map((s) => s.id));

  return (
    <div>
      {/* Selected services */}
      {value.length > 0 && (
        <div className="service-picker-selected">
          <div className="section-title" style={{ marginBottom: "0.5rem" }}>
            {t("editor.selectedServices", { count: value.length })}
          </div>
          {value.map((svc, i) =>
            svc.provider === "custom" ? (
              <div key={i} className="service-picker-selected-card">
                <div className="service-picker-selected-header">
                  <div className="service-picker-selected-info">
                    <strong>{svc.id || t("editor.addCustomService")}</strong>
                    <span className="service-provider">custom</span>
                  </div>
                  <button type="button" className="btn-remove" onClick={() => remove(i)}>
                    &times;
                  </button>
                </div>
                <div className="service-picker-selected-fields">
                  <input
                    type="text"
                    placeholder={t("editor.customServiceIdPlaceholder")}
                    value={svc.id}
                    onChange={(e) => update(i, { id: e.target.value })}
                  />
                  <input
                    type="text"
                    placeholder={t("editor.scopeDesc")}
                    value={svc.description}
                    onChange={(e) => update(i, { description: e.target.value })}
                  />
                  <select
                    value={svc.connectionMode}
                    onChange={(e) =>
                      update(i, { connectionMode: e.target.value as "user" | "admin" })
                    }
                  >
                    <option value="user">{t("editor.modeUser")}</option>
                    <option value="admin">{t("editor.modeAdmin")}</option>
                  </select>
                </div>
                <SchemaSection
                  mode="credentials"
                  title={t("editor.credentialSchema")}
                  fields={svc.credentialSchema}
                  onChange={(fields: SchemaField[]) => update(i, { credentialSchema: fields })}
                />
                <div className="service-picker-uris">
                  <label className="field-label field-label-checkbox">
                    <input
                      type="checkbox"
                      checked={svc.allowAllUris}
                      onChange={(e) => update(i, { allowAllUris: e.target.checked })}
                    />
                    {t("editor.allowAllUris")}
                  </label>
                  <span className="field-hint">{t("editor.allowAllUrisHint")}</span>
                  {!svc.allowAllUris && (
                    <>
                      <label className="field-label" style={{ marginTop: "0.5rem" }}>
                        {t("editor.authorizedUris")}
                      </label>
                      <textarea
                        rows={3}
                        placeholder={t("editor.authorizedUrisPlaceholder")}
                        value={svc.authorizedUris}
                        onChange={(e) => update(i, { authorizedUris: e.target.value })}
                      />
                      <span className="field-hint">{t("editor.authorizedUrisHint")}</span>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div key={i} className="service-picker-selected-card">
                <div className="service-picker-selected-header">
                  {integrations?.find((ig) => ig.uniqueKey === svc.id)?.logo && (
                    <img
                      src={integrations.find((ig) => ig.uniqueKey === svc.id)!.logo}
                      alt=""
                      className="service-logo"
                    />
                  )}
                  <div className="service-picker-selected-info">
                    <strong>{svc.id}</strong>
                    <span className="service-provider">{svc.provider}</span>
                  </div>
                  <button type="button" className="btn-remove" onClick={() => remove(i)}>
                    &times;
                  </button>
                </div>
                <div className="service-picker-selected-fields">
                  <input
                    type="text"
                    placeholder={t("editor.scopeDesc")}
                    value={svc.description}
                    onChange={(e) => update(i, { description: e.target.value })}
                  />
                  <input
                    type="text"
                    placeholder={t("editor.scopePlaceholder")}
                    value={svc.scopes}
                    onChange={(e) => update(i, { scopes: e.target.value })}
                  />
                  <select
                    value={svc.connectionMode}
                    onChange={(e) =>
                      update(i, { connectionMode: e.target.value as "user" | "admin" })
                    }
                  >
                    <option value="user">{t("editor.modeUser")}</option>
                    <option value="admin">{t("editor.modeAdmin")}</option>
                  </select>
                </div>
              </div>
            ),
          )}
        </div>
      )}

      {/* Available integrations from Nango */}
      <div className="section-title" style={{ marginTop: value.length > 0 ? "1rem" : 0 }}>
        {t("editor.availableIntegrations")}
      </div>
      {isLoading ? (
        <div className="empty-state empty-state-compact">{t("loading")}</div>
      ) : !integrations || integrations.length === 0 ? (
        <div className="empty-state empty-state-compact">{t("editor.noIntegration")}</div>
      ) : (
        <div className="service-picker-grid">
          {integrations.map((ig) => {
            const isSelected = selectedIds.has(ig.uniqueKey);
            return (
              <button
                key={ig.uniqueKey}
                type="button"
                className={`service-picker-card${isSelected ? " selected" : ""}`}
                onClick={() => addFromIntegration(ig.uniqueKey, ig.provider)}
                disabled={isSelected}
              >
                {ig.logo && <img src={ig.logo} alt="" className="service-logo" />}
                <div className="service-picker-card-info">
                  <span className="service-picker-card-name">{ig.displayName}</span>
                  <span className="service-provider">{ig.provider}</span>
                </div>
                {ig.authMode && <span className="auth-mode-badge">{ig.authMode}</span>}
                {isSelected && <span className="service-picker-check">&#10003;</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* Add custom service button */}
      <button
        type="button"
        className="add-field-btn"
        style={{ marginTop: "0.75rem" }}
        onClick={addCustomService}
      >
        {t("editor.addCustomService")}
      </button>
    </div>
  );
}
