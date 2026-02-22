import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Spinner } from "./spinner";
import { SchemaSection, type SchemaField } from "./flow-editor/schema-section";
import { schemaToFields, fieldsToSchema } from "./flow-editor/utils";
import { toSlug, toLiveSlug } from "../lib/strings";
import type { ProviderConfig, JSONSchemaObject, AvailableScope } from "@appstrate/shared-types";

interface ProviderFormModalProps {
  open: boolean;
  onClose: () => void;
  provider?: ProviderConfig | null; // null/undefined = create
  isPending: boolean;
  onSubmit: (data: Record<string, unknown>) => void;
}

interface FormData {
  id: string;
  displayName: string;
  authMode: string;
  iconUrl: string;
  docsUrl: string;
  categories: string;
  authorizationUrl: string;
  tokenUrl: string;
  refreshUrl: string;
  clientId: string;
  clientSecret: string;
  defaultScopes: string;
  scopeSeparator: string;
  pkceEnabled: boolean;
  credentialFieldName: string;
  credentialHeaderName: string;
  credentialHeaderPrefix: string;
  authorizedUris: string;
  allowAllUris: boolean;
}

function getInitial(provider: ProviderConfig | null | undefined): FormData {
  if (!provider) {
    return {
      id: "",
      displayName: "",
      authMode: "oauth2",
      iconUrl: "",
      docsUrl: "",
      categories: "",
      authorizationUrl: "",
      tokenUrl: "",
      refreshUrl: "",
      clientId: "",
      clientSecret: "",
      defaultScopes: "",
      scopeSeparator: " ",
      pkceEnabled: true,
      credentialFieldName: "",
      credentialHeaderName: "",
      credentialHeaderPrefix: "",
      authorizedUris: "",
      allowAllUris: false,
    };
  }
  return {
    id: provider.id,
    displayName: provider.displayName,
    authMode: provider.authMode as string,
    iconUrl: provider.iconUrl ?? "",
    docsUrl: provider.docsUrl ?? "",
    categories: provider.categories?.join(", ") ?? "",
    authorizationUrl: provider.authorizationUrl ?? "",
    tokenUrl: provider.tokenUrl ?? "",
    refreshUrl: provider.refreshUrl ?? "",
    clientId: "",
    clientSecret: "",
    defaultScopes: provider.defaultScopes?.join("\n") ?? "",
    scopeSeparator: provider.scopeSeparator ?? " ",
    pkceEnabled: provider.pkceEnabled ?? true,
    credentialFieldName: provider.credentialFieldName ?? "",
    credentialHeaderName: provider.credentialHeaderName ?? "",
    credentialHeaderPrefix: provider.credentialHeaderPrefix ?? "",
    authorizedUris: provider.authorizedUris?.join("\n") ?? "",
    allowAllUris: provider.allowAllUris ?? false,
  };
}

/**
 * Inner form component — remounted via key when provider/open changes,
 * so initial state is set directly via useState (no useEffect needed).
 */
function ProviderFormBody({
  provider,
  isPending,
  onSubmit,
  onClose,
}: {
  provider: ProviderConfig | null | undefined;
  isPending: boolean;
  onSubmit: (data: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const isEdit = !!provider;
  const isBuiltIn = isEdit && provider.source === "built-in";

  const [form, setForm] = useState<FormData>(() => getInitial(provider));
  const [idEdited, setIdEdited] = useState(isEdit);
  const [credentialFields, setCredentialFields] = useState<SchemaField[]>(() =>
    provider?.credentialSchema
      ? schemaToFields(provider.credentialSchema as unknown as JSONSchemaObject, "credentials")
      : [],
  );
  const [availableScopes, setAvailableScopes] = useState<AvailableScope[]>(
    () => provider?.availableScopes ?? [],
  );

  const setField = useCallback(<K extends keyof FormData>(key: K, value: FormData[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const data: Record<string, unknown> = {
      displayName: form.displayName,
      authMode: form.authMode,
    };

    if (!isEdit) data.id = form.id;
    if (form.iconUrl) data.iconUrl = form.iconUrl;
    if (form.docsUrl) data.docsUrl = form.docsUrl;
    if (form.categories.trim()) {
      data.categories = form.categories
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
    }

    if (form.authMode === "oauth2") {
      if (form.authorizationUrl) data.authorizationUrl = form.authorizationUrl;
      if (form.tokenUrl) data.tokenUrl = form.tokenUrl;
      if (form.refreshUrl) data.refreshUrl = form.refreshUrl;
      if (form.clientId) data.clientId = form.clientId;
      if (form.clientSecret) data.clientSecret = form.clientSecret;
      if (form.defaultScopes.trim()) {
        data.defaultScopes = form.defaultScopes
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      data.scopeSeparator = form.scopeSeparator;
      data.pkceEnabled = form.pkceEnabled;
      if (availableScopes.length > 0) {
        data.availableScopes = availableScopes.filter((s) => s.value.trim() && s.label.trim());
      }
    }

    if (form.authMode === "api_key") {
      if (form.credentialFieldName) data.credentialFieldName = form.credentialFieldName;
      if (form.credentialHeaderName) data.credentialHeaderName = form.credentialHeaderName;
      if (form.credentialHeaderPrefix) data.credentialHeaderPrefix = form.credentialHeaderPrefix;
    }

    if (form.authMode === "custom") {
      const schema = fieldsToSchema(credentialFields, "credentials");
      if (schema) data.credentialSchema = schema;
    }

    // Authorized URIs
    if (form.allowAllUris) {
      data.allowAllUris = true;
    } else {
      const uris = form.authorizedUris
        .split("\n")
        .map((u) => u.trim())
        .filter(Boolean);
      if (uris.length > 0) data.authorizedUris = uris;
    }

    onSubmit(data);
  };

  const title = isBuiltIn
    ? t("providers.form.title.configure")
    : isEdit
      ? t("providers.form.title.edit")
      : t("providers.form.title.create");

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      actions={
        <>
          <button onClick={onClose} disabled={isPending}>
            {t("btn.cancel", { ns: "common" })}
          </button>
          <button className="primary" onClick={handleSubmit} disabled={isPending}>
            {isPending ? <Spinner /> : t("btn.save", { ns: "common" })}
          </button>
        </>
      }
    >
      <form
        onSubmit={handleSubmit}
        style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
      >
        {/* General section */}
        <div className="form-group">
          <label htmlFor="pf-displayName">{t("providers.form.displayName")}</label>
          <input
            id="pf-displayName"
            type="text"
            value={form.displayName}
            onChange={(e) => {
              const name = e.target.value;
              setField("displayName", name);
              if (!idEdited) setField("id", toSlug(name));
            }}
            required
            readOnly={isBuiltIn}
          />
        </div>

        <div className="form-group">
          <label htmlFor="pf-id">{t("providers.form.id")}</label>
          <input
            id="pf-id"
            type="text"
            value={form.id}
            onChange={(e) => {
              setField("id", toLiveSlug(e.target.value));
              setIdEdited(true);
            }}
            onBlur={() => setField("id", toSlug(form.id))}
            placeholder={t("providers.form.idPlaceholder")}
            required
            readOnly={isEdit}
            pattern="[a-z0-9][a-z0-9-]*"
          />
          {!isEdit && <div className="hint">{t("providers.form.idHint")}</div>}
        </div>

        <div className="form-group">
          <label htmlFor="pf-authMode">{t("providers.form.authMode")}</label>
          <select
            id="pf-authMode"
            value={form.authMode}
            onChange={(e) => setField("authMode", e.target.value)}
            disabled={isEdit}
          >
            <option value="oauth2">{t("providers.authMode.oauth2")}</option>
            <option value="api_key">{t("providers.authMode.apiKey")}</option>
            <option value="basic">{t("providers.authMode.basic")}</option>
            <option value="custom">{t("providers.authMode.custom")}</option>
          </select>
        </div>

        <div style={{ display: "flex", gap: "0.5rem" }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="pf-iconUrl">{t("providers.form.iconUrl")}</label>
            <input
              id="pf-iconUrl"
              type="text"
              value={form.iconUrl}
              onChange={(e) => setField("iconUrl", e.target.value)}
              placeholder="https://..."
            />
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="pf-docsUrl">{t("providers.form.docsUrl")}</label>
            <input
              id="pf-docsUrl"
              type="text"
              value={form.docsUrl}
              onChange={(e) => setField("docsUrl", e.target.value)}
              placeholder="https://..."
            />
          </div>
        </div>

        <div className="form-group">
          <label htmlFor="pf-categories">{t("providers.form.categories")}</label>
          <input
            id="pf-categories"
            type="text"
            value={form.categories}
            onChange={(e) => setField("categories", e.target.value)}
            placeholder={t("providers.form.categoriesPlaceholder")}
          />
        </div>

        {/* OAuth2 section */}
        {form.authMode === "oauth2" && (
          <>
            <div className="section-title" style={{ marginTop: "0.5rem" }}>
              {t("providers.form.sectionOAuth2")}
            </div>

            <div className="form-group">
              <label htmlFor="pf-authorizationUrl">{t("providers.form.authorizationUrl")}</label>
              <input
                id="pf-authorizationUrl"
                type="text"
                value={form.authorizationUrl}
                onChange={(e) => setField("authorizationUrl", e.target.value)}
                readOnly={isBuiltIn}
              />
            </div>

            <div className="form-group">
              <label htmlFor="pf-tokenUrl">{t("providers.form.tokenUrl")}</label>
              <input
                id="pf-tokenUrl"
                type="text"
                value={form.tokenUrl}
                onChange={(e) => setField("tokenUrl", e.target.value)}
                readOnly={isBuiltIn}
              />
            </div>

            <div className="form-group">
              <label htmlFor="pf-refreshUrl">{t("providers.form.refreshUrl")}</label>
              <input
                id="pf-refreshUrl"
                type="text"
                value={form.refreshUrl}
                onChange={(e) => setField("refreshUrl", e.target.value)}
                readOnly={isBuiltIn}
              />
            </div>

            <div className="form-group">
              <label htmlFor="pf-clientId">{t("providers.form.clientId")}</label>
              <input
                id="pf-clientId"
                type="password"
                value={form.clientId}
                onChange={(e) => setField("clientId", e.target.value)}
                placeholder={
                  isEdit && provider?.hasClientId ? t("providers.form.secretUnchanged") : ""
                }
              />
            </div>

            <div className="form-group">
              <label htmlFor="pf-clientSecret">{t("providers.form.clientSecret")}</label>
              <input
                id="pf-clientSecret"
                type="password"
                value={form.clientSecret}
                onChange={(e) => setField("clientSecret", e.target.value)}
                placeholder={
                  isEdit && provider?.hasClientSecret ? t("providers.form.secretUnchanged") : ""
                }
              />
            </div>

            <div className="form-group">
              <label htmlFor="pf-scopes">{t("providers.form.defaultScopes")}</label>
              <textarea
                id="pf-scopes"
                value={form.defaultScopes}
                onChange={(e) => setField("defaultScopes", e.target.value)}
                rows={3}
                readOnly={isBuiltIn}
              />
              <div className="hint">{t("providers.form.scopesHint")}</div>
            </div>

            <div style={{ display: "flex", gap: "0.5rem" }}>
              <div className="form-group" style={{ flex: 1 }}>
                <label htmlFor="pf-scopeSep">{t("providers.form.scopeSeparator")}</label>
                <select
                  id="pf-scopeSep"
                  value={form.scopeSeparator}
                  onChange={(e) => setField("scopeSeparator", e.target.value)}
                  disabled={isBuiltIn}
                >
                  <option value=" ">{t("providers.form.scopeSepSpace")}</option>
                  <option value=",">{t("providers.form.scopeSepComma")}</option>
                  <option value="+">{t("providers.form.scopeSepPlus")}</option>
                </select>
              </div>
              <div
                className="form-group"
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "flex-end",
                  gap: "0.5rem",
                  paddingBottom: "0.25rem",
                }}
              >
                <input
                  id="pf-pkce"
                  type="checkbox"
                  checked={form.pkceEnabled}
                  onChange={(e) => setField("pkceEnabled", e.target.checked)}
                  disabled={isBuiltIn}
                  style={{ width: "auto" }}
                />
                <label htmlFor="pf-pkce" style={{ margin: 0 }}>
                  {t("providers.form.pkceEnabled")}
                </label>
              </div>
            </div>

            {/* Available scopes section */}
            {!isBuiltIn && (
              <>
                <div className="section-title" style={{ marginTop: "0.5rem" }}>
                  {t("providers.form.sectionAvailableScopes")}
                </div>
                <div className="hint" style={{ marginBottom: "0.5rem" }}>
                  {t("providers.form.availableScopesHint")}
                </div>
                {availableScopes.map((scope, idx) => (
                  <div key={idx} className="field-card" style={{ marginBottom: "0.375rem" }}>
                    <div style={{ display: "flex", gap: "0.375rem", alignItems: "center" }}>
                      <input
                        type="text"
                        placeholder={t("providers.form.scopeValue")}
                        value={scope.value}
                        onChange={(e) => {
                          const next = [...availableScopes];
                          next[idx] = { ...next[idx], value: e.target.value };
                          setAvailableScopes(next);
                        }}
                        style={{ flex: 2 }}
                      />
                      <input
                        type="text"
                        placeholder={t("providers.form.scopeLabel")}
                        value={scope.label}
                        onChange={(e) => {
                          const next = [...availableScopes];
                          next[idx] = { ...next[idx], label: e.target.value };
                          setAvailableScopes(next);
                        }}
                        style={{ flex: 1 }}
                      />
                      <button
                        type="button"
                        className="btn-remove"
                        onClick={() =>
                          setAvailableScopes(availableScopes.filter((_, i) => i !== idx))
                        }
                      >
                        &times;
                      </button>
                    </div>
                    <input
                      type="text"
                      placeholder={t("providers.form.scopeDescription")}
                      value={scope.description ?? ""}
                      onChange={(e) => {
                        const next = [...availableScopes];
                        next[idx] = { ...next[idx], description: e.target.value || undefined };
                        setAvailableScopes(next);
                      }}
                      style={{ marginTop: "0.25rem", width: "100%" }}
                    />
                  </div>
                ))}
                <button
                  type="button"
                  className="add-field-btn"
                  onClick={() => setAvailableScopes([...availableScopes, { value: "", label: "" }])}
                >
                  {t("providers.form.addAvailableScope")}
                </button>
              </>
            )}

            {/* Read-only display for built-in providers */}
            {isBuiltIn && provider?.availableScopes && provider.availableScopes.length > 0 && (
              <>
                <div className="section-title" style={{ marginTop: "0.5rem" }}>
                  {t("providers.form.sectionAvailableScopes")}
                </div>
                <div className="scope-options">
                  {provider.availableScopes.map((scope) => (
                    <div key={scope.value} className="scope-option" style={{ cursor: "default" }}>
                      <div className="scope-option-info">
                        <span className="scope-label">{scope.label}</span>
                        <span className="scope-value">{scope.value}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {/* API Key section */}
        {form.authMode === "api_key" && (
          <>
            <div className="section-title" style={{ marginTop: "0.5rem" }}>
              {t("providers.form.sectionApiKey")}
            </div>

            <div className="form-group">
              <label htmlFor="pf-credFieldName">{t("providers.form.credentialFieldName")}</label>
              <input
                id="pf-credFieldName"
                type="text"
                value={form.credentialFieldName}
                onChange={(e) => setField("credentialFieldName", e.target.value)}
                placeholder="api_key"
                readOnly={isBuiltIn}
              />
            </div>

            <div className="form-group">
              <label htmlFor="pf-credHeaderName">{t("providers.form.credentialHeaderName")}</label>
              <input
                id="pf-credHeaderName"
                type="text"
                value={form.credentialHeaderName}
                onChange={(e) => setField("credentialHeaderName", e.target.value)}
                placeholder="api-key"
                readOnly={isBuiltIn}
              />
            </div>

            <div className="form-group">
              <label htmlFor="pf-credHeaderPrefix">
                {t("providers.form.credentialHeaderPrefix")}
              </label>
              <input
                id="pf-credHeaderPrefix"
                type="text"
                value={form.credentialHeaderPrefix}
                onChange={(e) => setField("credentialHeaderPrefix", e.target.value)}
                placeholder="Bearer "
                readOnly={isBuiltIn}
              />
            </div>
          </>
        )}

        {/* Custom credential fields section */}
        {form.authMode === "custom" && (
          <SchemaSection
            title={t("providers.form.sectionCredentials")}
            mode="credentials"
            fields={credentialFields}
            onChange={setCredentialFields}
          />
        )}

        {/* Authorized URIs section */}
        {!isBuiltIn && (
          <>
            <div className="section-title" style={{ marginTop: "0.5rem" }}>
              {t("providers.form.sectionUris")}
            </div>

            <div className="form-group">
              <label className="field-label field-label-checkbox">
                <input
                  type="checkbox"
                  checked={form.allowAllUris}
                  onChange={(e) => setField("allowAllUris", e.target.checked)}
                  style={{ width: "auto" }}
                />
                {t("providers.form.allowAllUris")}
              </label>
              <div className="hint">{t("providers.form.allowAllUrisHint")}</div>
            </div>

            {!form.allowAllUris && (
              <div className="form-group">
                <label htmlFor="pf-uris">{t("providers.form.authorizedUris")}</label>
                <textarea
                  id="pf-uris"
                  value={form.authorizedUris}
                  onChange={(e) => setField("authorizedUris", e.target.value)}
                  rows={3}
                  placeholder="https://api.example.com/*"
                />
                <div className="hint">{t("providers.form.authorizedUrisHint")}</div>
              </div>
            )}
          </>
        )}
      </form>
    </Modal>
  );
}

export function ProviderFormModal({
  open,
  onClose,
  provider,
  isPending,
  onSubmit,
}: ProviderFormModalProps) {
  if (!open) return null;

  // Key forces remount when provider changes, resetting all state
  const key = provider?.id ?? "__create__";

  return (
    <ProviderFormBody
      key={key}
      provider={provider}
      isPending={isPending}
      onSubmit={onSubmit}
      onClose={onClose}
    />
  );
}
