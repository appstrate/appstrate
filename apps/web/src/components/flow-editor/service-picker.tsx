import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useServices } from "../../hooks/use-services";
import { SchemaSection } from "./schema-section";
import type { SchemaField } from "./schema-section";
import type { ServiceEntry } from "./types";
import type { CredentialPresetId } from "./credential-presets";
import { CREDENTIAL_PRESETS, presetToFields } from "./credential-presets";
import { toSlug } from "../../lib/strings";

const SLUG_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

interface ServicePickerProps {
  value: ServiceEntry[];
  onChange: (value: ServiceEntry[]) => void;
  isEdit?: boolean;
}

function CustomServiceCard({
  svc,
  index,
  isEdit,
  onUpdate,
  onRemove,
}: {
  svc: ServiceEntry;
  index: number;
  isEdit?: boolean;
  onUpdate: (index: number, patch: Partial<ServiceEntry>) => void;
  onRemove: (index: number) => void;
}) {
  const { t } = useTranslation(["flows", "common"]);
  const [idEdited, setIdEdited] = useState(isEdit || !!svc.id);

  const slugValid = !svc.id || SLUG_REGEX.test(svc.id);

  const handleNameChange = (name: string) => {
    if (idEdited) {
      onUpdate(index, { name });
    } else {
      onUpdate(index, { name, id: toSlug(name) });
    }
  };

  const handleIdChange = (id: string) => {
    setIdEdited(true);
    onUpdate(index, { id });
  };

  const handlePresetChange = (presetId: CredentialPresetId) => {
    if (presetId === "custom") {
      // Switch to custom — keep current fields as starting point
      onUpdate(index, { schemaPreset: "custom" });
    } else {
      const fields = presetToFields(presetId);
      onUpdate(index, { schemaPreset: presetId, credentialSchema: fields });
    }
  };

  const isCustomPreset = svc.schemaPreset === "custom";
  const presetDef = CREDENTIAL_PRESETS.find((p) => p.id === svc.schemaPreset);

  return (
    <div className="service-picker-selected-card">
      <div className="service-picker-selected-header">
        <div className="service-picker-selected-info">
          <strong>{svc.name || svc.id || t("editor.addCustomService")}</strong>
        </div>
        <button type="button" className="btn-remove" onClick={() => onRemove(index)}>
          &times;
        </button>
      </div>
      <div className="custom-svc-fields">
        <div className="custom-svc-name-row">
          <div className="custom-svc-name-group">
            <label className="field-label">{t("editor.customServiceName")}</label>
            <input
              type="text"
              placeholder={t("editor.customServiceNamePlaceholder")}
              value={svc.name}
              onChange={(e) => handleNameChange(e.target.value)}
            />
          </div>
          <div className="custom-svc-id-group">
            <label className="field-label">
              {t("editor.customServiceIdentifier")}
              {!idEdited && svc.name && <span className="auto-badge">auto</span>}
            </label>
            <input
              type="text"
              placeholder={t("editor.customServiceIdentifierPlaceholder")}
              value={svc.id}
              onChange={(e) => handleIdChange(e.target.value)}
              className={`custom-svc-id-input${!slugValid ? " identifier-invalid" : ""}`}
            />
            {!slugValid && (
              <span className="field-hint field-hint-error">
                {t("editor.customServiceIdentifierInvalid")}
              </span>
            )}
          </div>
        </div>
        <input
          type="text"
          className="custom-svc-desc-input"
          placeholder={t("editor.scopeDesc")}
          value={svc.description}
          onChange={(e) => onUpdate(index, { description: e.target.value })}
        />
        <div className="custom-svc-selects-row">
          <select
            value={svc.connectionMode}
            onChange={(e) =>
              onUpdate(index, { connectionMode: e.target.value as "user" | "admin" })
            }
          >
            <option value="user">{t("editor.modeUser")}</option>
            <option value="admin">{t("editor.modeAdmin")}</option>
          </select>
          <select
            value={svc.schemaPreset}
            onChange={(e) => handlePresetChange(e.target.value as CredentialPresetId)}
          >
            {CREDENTIAL_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {t(p.labelKey)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <SchemaSection
        mode="credentials"
        title={
          isCustomPreset
            ? t("editor.credentialSchema")
            : presetDef?.labelKey
              ? t(presetDef.labelKey)
              : t("editor.credentialSchema")
        }
        fields={svc.credentialSchema}
        onChange={(fields: SchemaField[]) => onUpdate(index, { credentialSchema: fields })}
        readOnly={!isCustomPreset}
      />
      <div className="service-picker-uris">
        <label className="field-label field-label-checkbox">
          <input
            type="checkbox"
            checked={svc.allowAllUris}
            onChange={(e) => onUpdate(index, { allowAllUris: e.target.checked })}
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
              onChange={(e) => onUpdate(index, { authorizedUris: e.target.value })}
            />
            <span className="field-hint">{t("editor.authorizedUrisHint")}</span>
          </>
        )}
      </div>
    </div>
  );
}

export function ServicePicker({ value, onChange, isEdit }: ServicePickerProps) {
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
        name: "",
        provider,
        description: "",
        scopes: "",
        connectionMode: "user",
        credentialSchema: [],
        authorizedUris: "",
        allowAllUris: false,
        schemaPreset: "custom",
      },
    ]);
  };

  const addCustomService = () => {
    const defaultFields = presetToFields("api_key");
    onChange([
      ...value,
      {
        id: "",
        name: "",
        provider: "custom",
        description: "",
        scopes: "",
        connectionMode: "user",
        credentialSchema: defaultFields,
        authorizedUris: "",
        allowAllUris: false,
        schemaPreset: "api_key",
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
              <CustomServiceCard
                key={i}
                svc={svc}
                index={i}
                isEdit={isEdit}
                onUpdate={update}
                onRemove={remove}
              />
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
