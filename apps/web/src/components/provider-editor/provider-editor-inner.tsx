import { useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useCreateProvider, useUpdateProvider } from "../../hooks/use-mutations";
import { api } from "../../api";
import { useUnsavedChanges } from "../../hooks/use-unsaved-changes";
import { UnsavedChangesModal } from "../unsaved-changes-modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { JsonEditor } from "../json-editor";
import { MetadataSection, type MetadataState } from "../flow-editor/metadata-section";
import { SchemaSection, type SchemaField } from "../flow-editor/schema-section";
import { schemaToFields, fieldsToSchema, getManifestName } from "../flow-editor/utils";
import { EditorShell } from "../editor-shell";
import type { ProviderConfig, JSONSchemaObject, AvailableScope } from "@appstrate/shared-types";

type ProviderEditorTab = "general" | "auth" | "uris" | "json";

interface ProviderFields {
  authMode: string;
  iconUrl: string;
  docsUrl: string;
  categories: string;
  authorizationUrl: string;
  tokenUrl: string;
  refreshUrl: string;
  requestTokenUrl: string;
  accessTokenUrl: string;
  clientId: string;
  clientSecret: string;
  defaultScopes: string;
  scopeSeparator: string;
  pkceEnabled: boolean;
  tokenAuthMethod: string;
  credentialFieldName: string;
  credentialHeaderName: string;
  credentialHeaderPrefix: string;
  authorizedUris: string;
  allowAllUris: boolean;
}

function getInitialMetadata(
  provider: ProviderConfig | null | undefined,
  orgSlug?: string,
): MetadataState {
  if (!provider) {
    return {
      id: "",
      scope: orgSlug ?? "",
      version: "1.0.0",
      displayName: "",
      description: "",
      author: "",
      keywords: [],
    };
  }
  const { scope, id } = getManifestName({ name: provider.id });
  return {
    id,
    scope: scope || (orgSlug ?? ""),
    version: provider.version ?? "1.0.0",
    displayName: provider.displayName,
    description: provider.description ?? "",
    author: provider.author ?? "",
    keywords: [],
  };
}

function getInitialFields(provider: ProviderConfig | null | undefined): ProviderFields {
  if (!provider) {
    return {
      authMode: "oauth2",
      iconUrl: "",
      docsUrl: "",
      categories: "",
      authorizationUrl: "",
      tokenUrl: "",
      refreshUrl: "",
      requestTokenUrl: "",
      accessTokenUrl: "",
      clientId: "",
      clientSecret: "",
      defaultScopes: "",
      scopeSeparator: " ",
      pkceEnabled: true,
      tokenAuthMethod: "client_secret_post",
      credentialFieldName: "",
      credentialHeaderName: "",
      credentialHeaderPrefix: "",
      authorizedUris: "",
      allowAllUris: false,
    };
  }
  return {
    authMode: provider.authMode as string,
    iconUrl: provider.iconUrl ?? "",
    docsUrl: provider.docsUrl ?? "",
    categories: provider.categories?.join(", ") ?? "",
    authorizationUrl: provider.authorizationUrl ?? "",
    tokenUrl: provider.tokenUrl ?? "",
    refreshUrl: provider.refreshUrl ?? "",
    requestTokenUrl: provider.requestTokenUrl ?? "",
    accessTokenUrl: provider.accessTokenUrl ?? "",
    clientId: "",
    clientSecret: "",
    defaultScopes: provider.defaultScopes?.join("\n") ?? "",
    scopeSeparator: provider.scopeSeparator ?? " ",
    pkceEnabled: provider.pkceEnabled ?? true,
    tokenAuthMethod: provider.tokenAuthMethod ?? "client_secret_post",
    credentialFieldName: provider.credentialFieldName ?? "",
    credentialHeaderName: provider.credentialHeaderName ?? "",
    credentialHeaderPrefix: provider.credentialHeaderPrefix ?? "",
    authorizedUris: provider.authorizedUris?.join("\n") ?? "",
    allowAllUris: provider.allowAllUris ?? false,
  };
}

function buildPayload(
  metadata: MetadataState,
  fields: ProviderFields,
  isEdit: boolean,
  availableScopes: AvailableScope[],
  credentialFields: SchemaField[],
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    displayName: metadata.displayName,
    version: metadata.version,
    description: metadata.description,
    author: metadata.author,
    authMode: fields.authMode,
  };

  if (!isEdit) {
    data.id = metadata.scope ? `@${metadata.scope}/${metadata.id}` : metadata.id;
  }

  if (fields.iconUrl) data.iconUrl = fields.iconUrl;
  if (fields.docsUrl) data.docsUrl = fields.docsUrl;
  if (fields.categories.trim()) {
    data.categories = fields.categories
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
  }

  if (fields.authMode === "oauth2") {
    if (fields.authorizationUrl) data.authorizationUrl = fields.authorizationUrl;
    if (fields.tokenUrl) data.tokenUrl = fields.tokenUrl;
    if (fields.refreshUrl) data.refreshUrl = fields.refreshUrl;
    if (fields.clientId) data.clientId = fields.clientId;
    if (fields.clientSecret) data.clientSecret = fields.clientSecret;
    if (fields.defaultScopes.trim()) {
      data.defaultScopes = fields.defaultScopes
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    data.scopeSeparator = fields.scopeSeparator;
    data.pkceEnabled = fields.pkceEnabled;
    data.tokenAuthMethod = fields.tokenAuthMethod;
    if (availableScopes.length > 0) {
      data.availableScopes = availableScopes.filter((s) => s.value.trim() && s.label.trim());
    }
  }

  if (fields.authMode === "oauth1") {
    if (fields.requestTokenUrl) data.requestTokenUrl = fields.requestTokenUrl;
    if (fields.authorizationUrl) data.authorizationUrl = fields.authorizationUrl;
    if (fields.accessTokenUrl) data.accessTokenUrl = fields.accessTokenUrl;
    if (fields.clientId) data.clientId = fields.clientId;
    if (fields.clientSecret) data.clientSecret = fields.clientSecret;
  }

  if (fields.authMode === "api_key") {
    if (fields.credentialFieldName) data.credentialFieldName = fields.credentialFieldName;
    if (fields.credentialHeaderName) data.credentialHeaderName = fields.credentialHeaderName;
    if (fields.credentialHeaderPrefix) data.credentialHeaderPrefix = fields.credentialHeaderPrefix;
  }

  if (fields.authMode === "custom") {
    const schema = fieldsToSchema(credentialFields, "credentials");
    if (schema) data.credentialSchema = schema;
  }

  if (fields.allowAllUris) {
    data.allowAllUris = true;
  } else {
    const uris = fields.authorizedUris
      .split("\n")
      .map((u) => u.trim())
      .filter(Boolean);
    if (uris.length > 0) data.authorizedUris = uris;
  }

  return data;
}

export interface ProviderEditorInnerProps {
  provider?: ProviderConfig | null;
  isEdit: boolean;
  packageId?: string;
  orgSlug?: string;
}

export function ProviderEditorInner({
  provider,
  isEdit,
  packageId,
  orgSlug,
}: ProviderEditorInnerProps) {
  const { t } = useTranslation(["settings", "flows", "common"]);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const createProvider = useCreateProvider();
  const updateProvider = useUpdateProvider();

  const [metadata, setMetadata] = useState<MetadataState>(() =>
    getInitialMetadata(provider, orgSlug),
  );
  const [fields, setFields] = useState<ProviderFields>(() => getInitialFields(provider));

  const [credentialFields, setCredentialFields] = useState<SchemaField[]>(() =>
    provider?.credentialSchema
      ? schemaToFields(provider.credentialSchema as unknown as JSONSchemaObject, "credentials")
      : [],
  );
  const [availableScopes, setAvailableScopes] = useState<AvailableScope[]>(
    () => provider?.availableScopes ?? [],
  );
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ProviderEditorTab>("general");

  // --- Unsaved changes detection ---
  const initialSnapshot = useMemo(
    () =>
      JSON.stringify({
        metadata: getInitialMetadata(provider, orgSlug),
        fields: getInitialFields(provider),
        credentialFields: provider?.credentialSchema
          ? schemaToFields(provider.credentialSchema as unknown as JSONSchemaObject, "credentials")
          : [],
        availableScopes: provider?.availableScopes ?? [],
      }),
    [provider, orgSlug],
  );
  const isDirty = useMemo(
    () =>
      initialSnapshot !== JSON.stringify({ metadata, fields, credentialFields, availableScopes }),
    [initialSnapshot, metadata, fields, credentialFields, availableScopes],
  );
  const { blocker, allowNavigation } = useUnsavedChanges(isDirty);

  const saveDraft = useCallback(async () => {
    if (!isEdit || !packageId) return;
    const data = buildPayload(metadata, fields, isEdit, availableScopes, credentialFields);
    await api(`/providers/${packageId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
    qc.invalidateQueries({ queryKey: ["providers"] });
  }, [metadata, fields, isEdit, packageId, availableScopes, credentialFields, qc]);

  const setField = useCallback(
    <K extends keyof ProviderFields>(key: K, value: ProviderFields[K]) => {
      setFields((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const handleSubmit = () => {
    setError(null);
    if (!metadata.id || !metadata.displayName) {
      setError(t("editor.errorRequired", { ns: "flows" }));
      setActiveTab("general");
      return;
    }

    allowNavigation();
    const data = buildPayload(metadata, fields, isEdit, availableScopes, credentialFields);

    if (isEdit && packageId) {
      updateProvider.mutate(
        { id: packageId, data },
        {
          onSuccess: () => navigate(`/providers/${packageId}`),
          onError: (err) => setError(err.message),
        },
      );
    } else {
      createProvider.mutate(data, {
        onSuccess: (result) => navigate(`/providers/${result.id}`),
        onError: (err) => setError(err.message),
      });
    }
  };

  const isPending = createProvider.isPending || updateProvider.isPending;

  const tabs: Array<{ id: ProviderEditorTab; label: string }> = [
    { id: "general", label: t("editor.tabGeneral", { ns: "flows" }) },
    { id: "auth", label: t("providers.form.authMode") },
    { id: "uris", label: t("providers.form.sectionUris") },
    { id: "json", label: t("editor.tabJson", { ns: "flows" }) },
  ];

  return (
    <EditorShell
      type="provider"
      packageId={packageId}
      isEdit={isEdit}
      displayName={metadata.displayName || packageId}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={(v) => setActiveTab(v as ProviderEditorTab)}
      error={error}
      isPending={isPending}
      onSubmit={handleSubmit}
      onCancel={() => navigate(isEdit ? `/providers/${packageId}` : "/providers")}
      hideSubmitBar={activeTab === "json"}
    >
      {/* ── General Tab ── */}
      {activeTab === "general" && (
        <>
          <MetadataSection value={metadata} onChange={setMetadata} isEdit={isEdit} />

          <div className="overflow-hidden rounded-lg border border-border bg-card mb-4">
            <div className="bg-background px-4 py-3 text-xs font-semibold uppercase tracking-wide text-foreground border-b border-border">
              {t("providers.form.sectionProvider")}
            </div>
            <div className="space-y-3 p-4">
              <div className="space-y-2">
                <Label htmlFor="pe-authMode">{t("providers.form.authMode")}</Label>
                <Select
                  value={fields.authMode}
                  onValueChange={(v) => setField("authMode", v)}
                  disabled={isEdit}
                >
                  <SelectTrigger id="pe-authMode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="oauth2">{t("providers.authMode.oauth2")}</SelectItem>
                    <SelectItem value="oauth1">{t("providers.authMode.oauth1")}</SelectItem>
                    <SelectItem value="api_key">{t("providers.authMode.apiKey")}</SelectItem>
                    <SelectItem value="basic">{t("providers.authMode.basic")}</SelectItem>
                    <SelectItem value="custom">{t("providers.authMode.custom")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex gap-3">
                <div className="space-y-1 flex-1">
                  <Label htmlFor="pe-iconUrl">{t("providers.form.iconUrl")}</Label>
                  <Input
                    id="pe-iconUrl"
                    type="text"
                    value={fields.iconUrl}
                    onChange={(e) => setField("iconUrl", e.target.value)}
                    placeholder="https://..."
                  />
                </div>
                <div className="space-y-1 flex-1">
                  <Label htmlFor="pe-docsUrl">{t("providers.form.docsUrl")}</Label>
                  <Input
                    id="pe-docsUrl"
                    type="text"
                    value={fields.docsUrl}
                    onChange={(e) => setField("docsUrl", e.target.value)}
                    placeholder="https://..."
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-categories">{t("providers.form.categories")}</Label>
                <Input
                  id="pe-categories"
                  type="text"
                  value={fields.categories}
                  onChange={(e) => setField("categories", e.target.value)}
                  placeholder={t("providers.form.categoriesPlaceholder")}
                />
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Auth Config Tab ── */}
      {activeTab === "auth" && (
        <div className="space-y-4">
          {/* OAuth2 */}
          {fields.authMode === "oauth2" && (
            <>
              <div className="text-sm font-medium text-muted-foreground">
                {t("providers.form.sectionOAuth2")}
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-authorizationUrl">{t("providers.form.authorizationUrl")}</Label>
                <Input
                  id="pe-authorizationUrl"
                  type="text"
                  value={fields.authorizationUrl}
                  onChange={(e) => setField("authorizationUrl", e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-tokenUrl">{t("providers.form.tokenUrl")}</Label>
                <Input
                  id="pe-tokenUrl"
                  type="text"
                  value={fields.tokenUrl}
                  onChange={(e) => setField("tokenUrl", e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-refreshUrl">{t("providers.form.refreshUrl")}</Label>
                <Input
                  id="pe-refreshUrl"
                  type="text"
                  value={fields.refreshUrl}
                  onChange={(e) => setField("refreshUrl", e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-clientId">{t("providers.form.clientId")}</Label>
                <Input
                  id="pe-clientId"
                  type="password"
                  value={fields.clientId}
                  onChange={(e) => setField("clientId", e.target.value)}
                  placeholder={
                    isEdit && provider?.hasCredentials ? t("providers.form.secretUnchanged") : ""
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-clientSecret">{t("providers.form.clientSecret")}</Label>
                <Input
                  id="pe-clientSecret"
                  type="password"
                  value={fields.clientSecret}
                  onChange={(e) => setField("clientSecret", e.target.value)}
                  placeholder={
                    isEdit && provider?.hasCredentials ? t("providers.form.secretUnchanged") : ""
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-scopes">{t("providers.form.defaultScopes")}</Label>
                <Textarea
                  id="pe-scopes"
                  value={fields.defaultScopes}
                  onChange={(e) => setField("defaultScopes", e.target.value)}
                  rows={3}
                />
                <div className="text-sm text-muted-foreground">
                  {t("providers.form.scopesHint")}
                </div>
              </div>

              <div className="flex gap-3">
                <div className="space-y-1 flex-1">
                  <Label htmlFor="pe-scopeSep">{t("providers.form.scopeSeparator")}</Label>
                  <Select
                    value={fields.scopeSeparator}
                    onValueChange={(v) => setField("scopeSeparator", v)}
                  >
                    <SelectTrigger id="pe-scopeSep">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value=" ">{t("providers.form.scopeSepSpace")}</SelectItem>
                      <SelectItem value=",">{t("providers.form.scopeSepComma")}</SelectItem>
                      <SelectItem value="+">{t("providers.form.scopeSepPlus")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1 flex-1">
                  <Label htmlFor="pe-tokenAuthMethod">{t("providers.form.tokenAuthMethod")}</Label>
                  <Select
                    value={fields.tokenAuthMethod}
                    onValueChange={(v) => setField("tokenAuthMethod", v)}
                  >
                    <SelectTrigger id="pe-tokenAuthMethod">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="client_secret_post">
                        {t("providers.form.tokenAuthPost")}
                      </SelectItem>
                      <SelectItem value="client_secret_basic">
                        {t("providers.form.tokenAuthBasic")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1 flex-1 flex items-end gap-2">
                  <input
                    id="pe-pkce"
                    type="checkbox"
                    checked={fields.pkceEnabled}
                    onChange={(e) => setField("pkceEnabled", e.target.checked)}
                    className="w-auto"
                  />
                  <Label htmlFor="pe-pkce" className="text-sm text-muted-foreground cursor-pointer">
                    {t("providers.form.pkceEnabled")}
                  </Label>
                </div>
              </div>

              {/* Available scopes editor */}
              <div className="text-sm font-medium text-muted-foreground mt-2">
                {t("providers.form.sectionAvailableScopes")}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("providers.form.availableScopesHint")}
              </div>
              {availableScopes.map((scope, idx) => (
                <div key={idx} className="border border-border rounded-md p-2.5 bg-card">
                  <div className="flex items-center gap-2">
                    <Input
                      type="text"
                      placeholder={t("providers.form.scopeValue")}
                      value={scope.value}
                      onChange={(e) => {
                        const next = [...availableScopes];
                        next[idx] = { ...next[idx], value: e.target.value };
                        setAvailableScopes(next);
                      }}
                      className="flex-[2] min-w-0"
                    />
                    <Input
                      type="text"
                      placeholder={t("providers.form.scopeLabel")}
                      value={scope.label}
                      onChange={(e) => {
                        const next = [...availableScopes];
                        next[idx] = { ...next[idx], label: e.target.value };
                        setAvailableScopes(next);
                      }}
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() =>
                        setAvailableScopes(availableScopes.filter((_, i) => i !== idx))
                      }
                    >
                      &times;
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-dashed text-xs text-muted-foreground hover:text-foreground hover:border-primary"
                onClick={() => setAvailableScopes([...availableScopes, { value: "", label: "" }])}
              >
                {t("providers.form.addAvailableScope")}
              </Button>
            </>
          )}

          {/* OAuth1 */}
          {fields.authMode === "oauth1" && (
            <>
              <div className="text-sm font-medium text-muted-foreground">
                {t("providers.form.sectionOAuth1")}
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-requestTokenUrl">{t("providers.form.requestTokenUrl")}</Label>
                <Input
                  id="pe-requestTokenUrl"
                  type="text"
                  value={fields.requestTokenUrl}
                  onChange={(e) => setField("requestTokenUrl", e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-authorizationUrl">{t("providers.form.authorizationUrl")}</Label>
                <Input
                  id="pe-authorizationUrl"
                  type="text"
                  value={fields.authorizationUrl}
                  onChange={(e) => setField("authorizationUrl", e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-accessTokenUrl">{t("providers.form.accessTokenUrl")}</Label>
                <Input
                  id="pe-accessTokenUrl"
                  type="text"
                  value={fields.accessTokenUrl}
                  onChange={(e) => setField("accessTokenUrl", e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-clientId">{t("providers.form.clientId")}</Label>
                <Input
                  id="pe-clientId"
                  type="password"
                  value={fields.clientId}
                  onChange={(e) => setField("clientId", e.target.value)}
                  placeholder={
                    isEdit && provider?.hasCredentials ? t("providers.form.secretUnchanged") : ""
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-clientSecret">{t("providers.form.clientSecret")}</Label>
                <Input
                  id="pe-clientSecret"
                  type="password"
                  value={fields.clientSecret}
                  onChange={(e) => setField("clientSecret", e.target.value)}
                  placeholder={
                    isEdit && provider?.hasCredentials ? t("providers.form.secretUnchanged") : ""
                  }
                />
              </div>
            </>
          )}

          {/* API Key */}
          {fields.authMode === "api_key" && (
            <>
              <div className="text-sm font-medium text-muted-foreground">
                {t("providers.form.sectionApiKey")}
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-credFieldName">{t("providers.form.credentialFieldName")}</Label>
                <Input
                  id="pe-credFieldName"
                  type="text"
                  value={fields.credentialFieldName}
                  onChange={(e) => setField("credentialFieldName", e.target.value)}
                  placeholder="api_key"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-credHeaderName">
                  {t("providers.form.credentialHeaderName")}
                </Label>
                <Input
                  id="pe-credHeaderName"
                  type="text"
                  value={fields.credentialHeaderName}
                  onChange={(e) => setField("credentialHeaderName", e.target.value)}
                  placeholder="api-key"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-credHeaderPrefix">
                  {t("providers.form.credentialHeaderPrefix")}
                </Label>
                <Input
                  id="pe-credHeaderPrefix"
                  type="text"
                  value={fields.credentialHeaderPrefix}
                  onChange={(e) => setField("credentialHeaderPrefix", e.target.value)}
                  placeholder="Bearer "
                />
              </div>
            </>
          )}

          {/* Custom credential schema */}
          {fields.authMode === "custom" && (
            <SchemaSection
              title={t("providers.form.sectionCredentials")}
              mode="credentials"
              fields={credentialFields}
              onChange={setCredentialFields}
            />
          )}

          {/* Basic — no extra fields */}
          {fields.authMode === "basic" && (
            <div className="text-sm text-muted-foreground py-4">
              {t("providers.authMode.basic")} —{" "}
              {t("providers.form.secretUnchanged", {
                defaultValue: "No additional configuration needed.",
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Authorization Tab ── */}
      {activeTab === "uris" && (
        <div className="space-y-4">
          <>
            <div className="space-y-2">
              <Label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={fields.allowAllUris}
                  onChange={(e) => setField("allowAllUris", e.target.checked)}
                />
                {t("providers.form.allowAllUris")}
              </Label>
              <div className="text-sm text-muted-foreground">
                {t("providers.form.allowAllUrisHint")}
              </div>
            </div>

            {!fields.allowAllUris && (
              <div className="space-y-2">
                <Label htmlFor="pe-uris">{t("providers.form.authorizedUris")}</Label>
                <Textarea
                  id="pe-uris"
                  value={fields.authorizedUris}
                  onChange={(e) => setField("authorizedUris", e.target.value)}
                  rows={5}
                  placeholder="https://api.example.com/*"
                />
                <div className="text-sm text-muted-foreground">
                  {t("providers.form.authorizedUrisHint")}
                </div>
              </div>
            )}
          </>
        </div>
      )}

      {/* ── JSON Tab ── */}
      {activeTab === "json" && (
        <JsonEditor
          value={buildPayload(metadata, fields, isEdit, availableScopes, credentialFields)}
          onApply={(parsed) => {
            const parsedName = getManifestName({ name: parsed.id as string });
            setMetadata((prev) => ({
              ...prev,
              displayName: (parsed.displayName as string) ?? prev.displayName,
              description: (parsed.description as string) ?? prev.description,
              version: (parsed.version as string) ?? prev.version,
              author: (parsed.author as string) ?? prev.author,
              ...(parsedName.scope ? { scope: parsedName.scope, id: parsedName.id } : {}),
            }));
            setFields((prev) => ({
              ...prev,
              authMode: (parsed.authMode as string) ?? prev.authMode,
              iconUrl: (parsed.iconUrl as string) ?? "",
              docsUrl: (parsed.docsUrl as string) ?? "",
              categories: Array.isArray(parsed.categories)
                ? (parsed.categories as string[]).join(", ")
                : prev.categories,
              authorizationUrl: (parsed.authorizationUrl as string) ?? "",
              tokenUrl: (parsed.tokenUrl as string) ?? "",
              refreshUrl: (parsed.refreshUrl as string) ?? "",
              requestTokenUrl: (parsed.requestTokenUrl as string) ?? "",
              accessTokenUrl: (parsed.accessTokenUrl as string) ?? "",
              clientId: (parsed.clientId as string) ?? "",
              clientSecret: (parsed.clientSecret as string) ?? "",
              defaultScopes: Array.isArray(parsed.defaultScopes)
                ? (parsed.defaultScopes as string[]).join("\n")
                : prev.defaultScopes,
              scopeSeparator: (parsed.scopeSeparator as string) ?? prev.scopeSeparator,
              pkceEnabled: (parsed.pkceEnabled as boolean) ?? prev.pkceEnabled,
              tokenAuthMethod: (parsed.tokenAuthMethod as string) ?? prev.tokenAuthMethod,
              credentialFieldName: (parsed.credentialFieldName as string) ?? "",
              credentialHeaderName: (parsed.credentialHeaderName as string) ?? "",
              credentialHeaderPrefix: (parsed.credentialHeaderPrefix as string) ?? "",
              authorizedUris: Array.isArray(parsed.authorizedUris)
                ? (parsed.authorizedUris as string[]).join("\n")
                : prev.authorizedUris,
              allowAllUris: (parsed.allowAllUris as boolean) ?? false,
            }));
            if (Array.isArray(parsed.availableScopes)) {
              setAvailableScopes(parsed.availableScopes as AvailableScope[]);
            }
            if (parsed.credentialSchema) {
              setCredentialFields(
                schemaToFields(
                  parsed.credentialSchema as unknown as JSONSchemaObject,
                  "credentials",
                ),
              );
            }
            setActiveTab("general");
          }}
        />
      )}

      <UnsavedChangesModal blocker={blocker} onSaveDraft={isEdit ? saveDraft : undefined} />
    </EditorShell>
  );
}
