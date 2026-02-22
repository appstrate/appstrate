import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import CreatableSelect from "react-select/creatable";
import type { StylesConfig, MultiValue } from "react-select";
import { Link } from "react-router-dom";
import { useProviders } from "../../hooks/use-providers";
import { useOrg } from "../../hooks/use-org";
import type { ServiceEntry } from "./types";
import type { AvailableScope, ProviderConfig } from "@appstrate/shared-types";

interface ServicePickerProps {
  value: ServiceEntry[];
  onChange: (value: ServiceEntry[]) => void;
}

interface ScopeOption {
  value: string;
  label: string;
}

const scopeSelectStyles: StylesConfig<ScopeOption, true> = {
  control: (base, state) => ({
    ...base,
    background: "var(--bg)",
    borderColor: state.isFocused ? "var(--primary)" : "var(--border)",
    borderRadius: "4px",
    minHeight: "34px",
    fontSize: "0.8rem",
    boxShadow: "none",
    "&:hover": { borderColor: "var(--text-muted)" },
  }),
  menu: (base) => ({
    ...base,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    zIndex: 20,
    overflow: "hidden",
  }),
  menuList: (base) => ({
    ...base,
    padding: "0.25rem",
  }),
  option: (base, state) => ({
    ...base,
    background: state.isFocused ? "var(--surface-hover)" : "transparent",
    color: state.isSelected ? "var(--primary)" : "var(--text)",
    fontSize: "0.8rem",
    padding: "0.375rem 0.5rem",
    borderRadius: "4px",
    cursor: "pointer",
    "&:active": { background: "var(--surface-hover)" },
  }),
  multiValue: (base) => ({
    ...base,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
  }),
  multiValueLabel: (base) => ({
    ...base,
    color: "var(--text)",
    fontSize: "0.75rem",
    padding: "0.1rem 0.375rem",
  }),
  multiValueRemove: (base) => ({
    ...base,
    color: "var(--text-muted)",
    "&:hover": { background: "rgba(239, 68, 68, 0.15)", color: "var(--danger)" },
  }),
  input: (base) => ({
    ...base,
    color: "var(--text)",
    fontSize: "0.8rem",
  }),
  placeholder: (base) => ({
    ...base,
    color: "var(--text-muted)",
    fontSize: "0.8rem",
  }),
  noOptionsMessage: (base) => ({
    ...base,
    color: "var(--text-muted)",
    fontSize: "0.8rem",
  }),
  clearIndicator: (base) => ({
    ...base,
    color: "var(--text-muted)",
    padding: "0 4px",
    "&:hover": { color: "var(--text)" },
  }),
  dropdownIndicator: (base) => ({
    ...base,
    color: "var(--text-muted)",
    padding: "0 4px",
    "&:hover": { color: "var(--text)" },
  }),
  indicatorSeparator: (base) => ({
    ...base,
    backgroundColor: "var(--border)",
  }),
  valueContainer: (base) => ({
    ...base,
    padding: "0 6px",
    gap: "2px",
  }),
};

function ScopeMultiSelect({
  scopes,
  availableScopes,
  onChange,
}: {
  scopes: string[];
  availableScopes?: AvailableScope[];
  onChange: (scopes: string[]) => void;
}) {
  const { t } = useTranslation("flows");

  const options: ScopeOption[] = useMemo(
    () =>
      (availableScopes ?? []).map((s) => ({
        value: s.value,
        label: s.label,
      })),
    [availableScopes],
  );

  const selectedOptions: ScopeOption[] = useMemo(() => {
    const knownMap = new Map(options.map((o) => [o.value, o]));
    return scopes.map((v) => knownMap.get(v) ?? { value: v, label: v });
  }, [scopes, options]);

  const handleChange = (newValue: MultiValue<ScopeOption>) => {
    onChange(newValue.map((o) => o.value));
  };

  const formatOptionLabel = (option: ScopeOption, ctx: { context: string }) => {
    if (ctx.context === "menu") {
      return (
        <div>
          <div style={{ fontWeight: 500 }}>{option.label}</div>
          <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: "1px" }}>
            {option.value}
          </div>
        </div>
      );
    }
    return option.label;
  };

  return (
    <CreatableSelect<ScopeOption, true>
      isMulti
      options={options}
      value={selectedOptions}
      onChange={handleChange}
      formatOptionLabel={formatOptionLabel}
      formatCreateLabel={(input) => input}
      placeholder={t("editor.customScopePlaceholder")}
      noOptionsMessage={() => null}
      styles={scopeSelectStyles}
      isClearable
      menuPlacement="auto"
    />
  );
}

export function ServicePicker({ value, onChange }: ServicePickerProps) {
  const { t } = useTranslation(["flows", "common", "settings"]);
  const { data: providers, isLoading } = useProviders();
  const { isOrgAdmin } = useOrg();

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
        scopes: [],
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
            const providerDef = providers?.find((p) => p.id === svc.provider) as
              | ProviderConfig
              | undefined;
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
                  {providerDef?.authMode === "oauth2" && (
                    <div className="service-picker-field">
                      <label className="service-picker-label">{t("editor.scopesLabel")}</label>
                      <ScopeMultiSelect
                        scopes={svc.scopes}
                        availableScopes={providerDef?.availableScopes}
                        onChange={(scopes) => update(i, { scopes })}
                      />
                    </div>
                  )}
                  <div className="service-picker-field">
                    <label className="service-picker-label">
                      {t("editor.connectionModeLabel")}
                    </label>
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
          {isOrgAdmin && (
            <Link
              to="/org-settings?tab=providers"
              className="service-picker-card service-picker-add-provider"
            >
              <span className="service-picker-add-icon">+</span>
              <div className="service-picker-card-info">
                <span className="service-picker-card-name">
                  {t("providers.addProvider", { ns: "settings" })}
                </span>
              </div>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
