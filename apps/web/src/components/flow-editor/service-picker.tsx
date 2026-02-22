import { useTranslation } from "react-i18next";
import { useProviders } from "../../hooks/use-providers";
import type { ServiceEntry } from "./types";

interface ServicePickerProps {
  value: ServiceEntry[];
  onChange: (value: ServiceEntry[]) => void;
}

export function ServicePicker({ value, onChange }: ServicePickerProps) {
  const { t } = useTranslation(["flows", "common"]);
  const { data: providers, isLoading } = useProviders();

  const update = (index: number, patch: Partial<ServiceEntry>) => {
    const next = value.map((s, i) => (i === index ? { ...s, ...patch } : s));
    onChange(next);
  };

  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  const addFromProvider = (providerId: string) => {
    const alreadySelected = value.some((s) => s.id === providerId);
    if (alreadySelected) return;
    onChange([
      ...value,
      {
        id: providerId,
        provider: providerId,
        scopes: "",
        connectionMode: "user",
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
          {value.map((svc, i) => {
            const providerDef = providers?.find((p) => p.id === svc.provider);
            return (
              <div key={i} className="service-picker-selected-card">
                <div className="service-picker-selected-header">
                  {providerDef?.iconUrl && (
                    <img src={providerDef.iconUrl} alt="" className="service-logo" />
                  )}
                  <div className="service-picker-selected-info">
                    <strong>{providerDef?.displayName ?? svc.id}</strong>
                    <span className="service-provider">{svc.provider}</span>
                  </div>
                  <button type="button" className="btn-remove" onClick={() => remove(i)}>
                    &times;
                  </button>
                </div>
                <div className="service-picker-selected-fields">
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
            );
          })}
        </div>
      )}

      {/* Available providers */}
      <div className="section-title" style={{ marginTop: value.length > 0 ? "1rem" : 0 }}>
        {t("editor.availableIntegrations")}
      </div>
      {isLoading ? (
        <div className="empty-state empty-state-compact">{t("loading")}</div>
      ) : !providers || providers.length === 0 ? (
        <div className="empty-state empty-state-compact">{t("editor.noIntegration")}</div>
      ) : (
        <div className="service-picker-grid">
          {providers.map((p) => {
            const isSelected = selectedIds.has(p.id);
            return (
              <button
                key={p.id}
                type="button"
                className={`service-picker-card${isSelected ? " selected" : ""}`}
                onClick={() => addFromProvider(p.id)}
                disabled={isSelected}
              >
                {p.iconUrl && <img src={p.iconUrl} alt="" className="service-logo" />}
                <div className="service-picker-card-info">
                  <span className="service-picker-card-name">{p.displayName}</span>
                  <span className="service-provider">{p.id}</span>
                </div>
                {isSelected && <span className="service-picker-check">&#10003;</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
