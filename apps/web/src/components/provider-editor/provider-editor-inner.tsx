// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useCreatePackage, useUpdatePackage } from "../../hooks/use-mutations";
import { PACKAGE_CONFIG } from "../../hooks/use-packages";
import { api } from "../../api";
import { useUnsavedChanges } from "../../hooks/use-unsaved-changes";
import { UnsavedChangesModal } from "../unsaved-changes-modal";
import { Checkbox } from "@/components/ui/checkbox";
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
import { MetadataSection, type MetadataState } from "../agent-editor/metadata-section";
import { SchemaSection, type SchemaField } from "../agent-editor/schema-section";
import {
  schemaToFields,
  fieldsToSchema,
  manifestToMetadata,
  metadataToManifestPatch,
  getManifestName,
} from "../agent-editor/utils";
import { SectionCard } from "../section-card";
import { EditorShell } from "../editor-shell";
import { ContentEditor } from "../package-editor/content-editor";
import { AFPS_SCHEMA_URLS, type AvailableScope } from "@appstrate/core/validation";
import { providerSchema } from "@appstrate/core/schemas";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { toCredentialKey } from "../../lib/strings";

type ProviderEditorTab = "general" | "auth" | "uris" | "content" | "json";

// ─── Manifest accessors for nested definition ──────────────

function getDef(m: Record<string, unknown>): Record<string, unknown> {
  return (m.definition ?? {}) as Record<string, unknown>;
}

function getAuthSub(m: Record<string, unknown>, mode: string): Record<string, unknown> {
  const def = getDef(m);
  return (def[mode] ?? {}) as Record<string, unknown>;
}

function updateDef(
  m: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...m, definition: { ...getDef(m), ...patch } };
}

function updateAuthSub(
  m: Record<string, unknown>,
  mode: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const def = getDef(m);
  return { ...m, definition: { ...def, [mode]: { ...getAuthSub(m, mode), ...patch } } };
}

// ─── Types ─────────────────────────────────────────────────

interface ProviderEditorState {
  manifest: Record<string, unknown>;
  content: string;
  lockVersion?: number;
}

// ─── Credential modes ──────────────────────────────────────

const CREDENTIAL_MODES = ["api_key", "basic", "custom"] as const;
type CredentialMode = (typeof CREDENTIAL_MODES)[number];

function isCredentialMode(mode: string): mode is CredentialMode {
  return (CREDENTIAL_MODES as readonly string[]).includes(mode);
}

function makeDefaultCredentialFields(mode: CredentialMode): SchemaField[] {
  const make = (key: string, format?: string): SchemaField => ({
    _id: crypto.randomUUID(),
    key,
    type: "string",
    description: "",
    required: true,
    ...(format ? { format } : {}),
  });
  switch (mode) {
    case "api_key":
      return [make("api_key")];
    case "basic":
      return [make("username"), make("password", "password")];
    case "custom":
      return [];
  }
}

/** Return a new definition with `credentials` written from fields, or removed if empty. */
function writeCredentialsToDef(
  def: Record<string, unknown>,
  fields: SchemaField[],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...def };
  const wrapper = fieldsToSchema(fields, "credentials");
  if (wrapper) {
    const existing = (def.credentials ?? {}) as Record<string, unknown>;
    next.credentials = { ...existing, schema: wrapper.schema };
  } else {
    delete next.credentials;
  }
  return next;
}

/** Patch `definition.credentials` (canonical nested shape). */
function patchCredentialsInDef(
  def: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const existing = (def.credentials ?? {}) as Record<string, unknown>;
  return { ...def, credentials: { ...existing, ...patch } };
}

/**
 * Migrate legacy flat `definition.credentialFieldName` to canonical nested
 * `definition.credentials.fieldName` on load. Produces a manifest in the
 * canonical shape so saves don't re-introduce the flat form.
 */
function migrateLegacyFieldName(def: Record<string, unknown>): Record<string, unknown> {
  if (!("credentialFieldName" in def)) return def;
  const flat = def.credentialFieldName as string | undefined;
  const next: Record<string, unknown> = { ...def };
  delete next.credentialFieldName;
  if (flat) {
    const existing = (next.credentials ?? {}) as Record<string, unknown>;
    if (existing.fieldName === undefined) {
      next.credentials = { ...existing, fieldName: flat };
    }
  }
  return next;
}

/**
 * Normalize the initial editor state: extract credential fields from the manifest,
 * and seed defaults in-place if the manifest declares a credential authMode but
 * lacks a schema (repairs legacy drafts so they pass AFPS validation on save).
 */
function normalizeProviderInitialState(initial: ProviderEditorState): {
  state: ProviderEditorState;
  credentialFields: SchemaField[];
} {
  // Migrate any legacy flat credentialFieldName into the canonical nested shape
  // on load. Subsequent writes use patchCredentialsInDef.
  const migratedDef = migrateLegacyFieldName(getDef(initial.manifest));
  const migratedManifest = { ...initial.manifest, definition: migratedDef };
  const migratedState: ProviderEditorState =
    migratedDef === getDef(initial.manifest) ? initial : { ...initial, manifest: migratedManifest };

  const def = migratedDef;
  const authMode = (def.authMode as string) || "oauth2";
  const creds = def.credentials as { schema?: JSONSchemaObject } | undefined;

  if (!isCredentialMode(authMode)) {
    return { state: migratedState, credentialFields: [] };
  }

  if (creds?.schema) {
    return {
      state: migratedState,
      credentialFields: schemaToFields(creds.schema, "credentials"),
    };
  }

  const seeded = makeDefaultCredentialFields(authMode);
  if (seeded.length === 0) {
    return { state: migratedState, credentialFields: [] };
  }

  return {
    state: {
      ...migratedState,
      manifest: {
        ...migratedState.manifest,
        definition: writeCredentialsToDef(def, seeded),
      },
    },
    credentialFields: seeded,
  };
}

// ─── Component ─────────────────────────────────────────────

export interface ProviderEditorInnerProps {
  initialState: ProviderEditorState;
  isEdit: boolean;
  packageId?: string;
}

export function ProviderEditorInner({ initialState, isEdit, packageId }: ProviderEditorInnerProps) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const createPkg = useCreatePackage("provider");
  const updatePkg = useUpdatePackage("provider", packageId || "");

  // Normalize once at mount: extract credential fields, repair legacy drafts
  // that declare a credential authMode without a schema. The normalized state
  // becomes the baseline for both `state` and `isDirty` comparisons.
  const [initialNormalized] = useState(() => normalizeProviderInitialState(initialState));
  const [state, setState] = useState(initialNormalized.state);
  const [credentialFields, setCredentialFields] = useState<SchemaField[]>(
    initialNormalized.credentialFields,
  );
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ProviderEditorTab>("general");
  const [jsonEditorKey, setJsonEditorKey] = useState(0);

  const updateManifest = (patch: Record<string, unknown>) =>
    setState((s) => ({ ...s, manifest: { ...s.manifest, ...patch } }));

  const patchDef = (patch: Record<string, unknown>) =>
    setState((s) => ({ ...s, manifest: updateDef(s.manifest, patch) }));

  const patchAuthSub = (mode: string, patch: Record<string, unknown>) =>
    setState((s) => ({ ...s, manifest: updateAuthSub(s.manifest, mode, patch) }));

  const metadata = useMemo(() => manifestToMetadata(state.manifest), [state.manifest]);
  const onMetadataChange = (m: MetadataState) => updateManifest(metadataToManifestPatch(m));

  const def = getDef(state.manifest);
  const authMode = (def.authMode as string) || "oauth2";
  const oauth2 = getAuthSub(state.manifest, "oauth2");
  const oauth1 = getAuthSub(state.manifest, "oauth1");

  // --- Unsaved changes detection ---
  const isDirty = useMemo(
    () => JSON.stringify(initialNormalized.state) !== JSON.stringify(state),
    [initialNormalized, state],
  );
  const { blocker, allowNavigation } = useUnsavedChanges(isDirty);

  const saveDraft = useCallback(async () => {
    if (!isEdit || !packageId) return;
    const cfg = PACKAGE_CONFIG.provider;
    await api(`/packages/${cfg.path}/${packageId}`, {
      method: "PUT",
      body: JSON.stringify({
        manifest: state.manifest,
        content: state.content,
        lockVersion: state.lockVersion!,
      }),
    });
    qc.invalidateQueries({ queryKey: ["packages"] });
    qc.invalidateQueries({ queryKey: ["providers"] });
  }, [state, isEdit, packageId, qc]);

  const handleSubmit = () => {
    setError(null);
    const { id } = getManifestName(state.manifest);
    if (!id || !state.manifest.displayName) {
      setError(t("editor.errorRequired", { ns: "agents" }));
      setActiveTab("general");
      return;
    }

    if (authMode === "oauth2") {
      if (!oauth2.authorizationUrl || !oauth2.tokenUrl) {
        setError(t("providers.form.errorOAuth2Required"));
        setActiveTab("auth");
        return;
      }
    } else if (authMode === "oauth1") {
      if (!oauth1.requestTokenUrl || !oauth1.accessTokenUrl) {
        setError(t("providers.form.errorOAuth1Required"));
        setActiveTab("auth");
        return;
      }
    } else if (authMode === "api_key" || authMode === "basic" || authMode === "custom") {
      if (credentialFields.length === 0) {
        setError(t("providers.form.errorCredentialsRequired"));
        setActiveTab("auth");
        return;
      }
    }

    allowNavigation();
    const body = { manifest: state.manifest, content: state.content };
    if (isEdit) {
      updatePkg.mutate(
        { ...body, lockVersion: state.lockVersion! },
        { onError: (err) => setError(err.message) },
      );
    } else {
      createPkg.mutate(body, { onError: (err) => setError(err.message) });
    }
  };

  const isPending = createPkg.isPending || updatePkg.isPending;

  const tabs: Array<{ id: ProviderEditorTab; label: string }> = [
    { id: "general", label: t("editor.tabGeneral", { ns: "agents" }) },
    { id: "auth", label: t("providers.form.authMode") },
    { id: "uris", label: t("providers.form.sectionUris") },
    { id: "content", label: t("editor.tabContent.provider", { ns: "agents" }) },
    { id: "json", label: t("editor.tabJson", { ns: "agents" }) },
  ];

  // --- Credential fields sync to manifest ---
  const onCredentialFieldsChange = (fields: SchemaField[]) => {
    setCredentialFields(fields);
    setState((s) => ({
      ...s,
      manifest: { ...s.manifest, definition: writeCredentialsToDef(getDef(s.manifest), fields) },
    }));
  };

  // --- AuthMode transition: keep definition.credentials consistent with mode ---
  const handleAuthModeChange = (newMode: string) => {
    const oldMode = authMode;
    if (newMode === oldMode) return;

    const wasCredMode = isCredentialMode(oldMode);
    const isNewCredMode = isCredentialMode(newMode);

    // Leaving the credential family → drop credentials entirely.
    if (wasCredMode && !isNewCredMode) {
      setCredentialFields([]);
      setState((s) => ({
        ...s,
        manifest: {
          ...s.manifest,
          definition: writeCredentialsToDef({ ...getDef(s.manifest), authMode: newMode }, []),
        },
      }));
      return;
    }

    // Entering (or switching within) the credential family.
    // api_key and basic have canonical shapes → always reset to defaults.
    // custom is user-defined → preserve existing fields as a starting point.
    if (isNewCredMode) {
      const keepExisting = newMode === "custom" && credentialFields.length > 0;
      const nextFields = keepExisting ? credentialFields : makeDefaultCredentialFields(newMode);
      if (!keepExisting) setCredentialFields(nextFields);
      setState((s) => ({
        ...s,
        manifest: {
          ...s.manifest,
          definition: writeCredentialsToDef(
            { ...getDef(s.manifest), authMode: newMode },
            nextFields,
          ),
        },
      }));
      return;
    }

    // Transitioning between two non-credential modes (oauth2 ↔ oauth1).
    patchDef({ authMode: newMode });
  };

  return (
    <EditorShell
      type="provider"
      packageId={packageId}
      isEdit={isEdit}
      displayName={(state.manifest.displayName as string) || packageId}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={(v) => {
        if (v === "json") setJsonEditorKey((k) => k + 1);
        setActiveTab(v as ProviderEditorTab);
      }}
      error={error}
      isPending={isPending}
      onSubmit={handleSubmit}
      onCancel={() => navigate(isEdit ? `/providers/${packageId}` : "/providers")}
      hideSubmitBar={activeTab === "json"}
    >
      {/* ── General Tab ── */}
      {activeTab === "general" && (
        <>
          <MetadataSection value={metadata} onChange={onMetadataChange} isEdit={isEdit} />

          <SectionCard title={t("providers.form.sectionProvider")}>
            <div className="space-y-2">
              <Label htmlFor="pe-authMode">{t("providers.form.authMode")}</Label>
              <Select value={authMode} onValueChange={handleAuthModeChange} disabled={isEdit}>
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
              <div className="flex-1 space-y-1">
                <Label htmlFor="pe-iconUrl">{t("providers.form.iconUrl")}</Label>
                <Input
                  id="pe-iconUrl"
                  type="text"
                  value={(state.manifest.iconUrl as string) ?? ""}
                  onChange={(e) => updateManifest({ iconUrl: e.target.value })}
                  placeholder="https://..."
                />
              </div>
              <div className="flex-1 space-y-1">
                <Label htmlFor="pe-docsUrl">{t("providers.form.docsUrl")}</Label>
                <Input
                  id="pe-docsUrl"
                  type="text"
                  value={(state.manifest.docsUrl as string) ?? ""}
                  onChange={(e) => updateManifest({ docsUrl: e.target.value })}
                  placeholder="https://..."
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="pe-categories">{t("providers.form.categories")}</Label>
              <Input
                id="pe-categories"
                type="text"
                value={
                  Array.isArray(state.manifest.categories)
                    ? (state.manifest.categories as string[]).join(", ")
                    : ""
                }
                onChange={(e) =>
                  updateManifest({
                    categories: e.target.value
                      .split(",")
                      .map((c) => c.trim())
                      .filter(Boolean),
                  })
                }
                placeholder={t("providers.form.categoriesPlaceholder")}
              />
            </div>
          </SectionCard>
        </>
      )}

      {/* ── Auth Config Tab ── */}
      {activeTab === "auth" && (
        <div className="space-y-4">
          {/* OAuth2 */}
          {authMode === "oauth2" && (
            <>
              <div className="text-muted-foreground text-sm font-medium">
                {t("providers.form.sectionOAuth2")}
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-authorizationUrl">{t("providers.form.authorizationUrl")}</Label>
                <Input
                  id="pe-authorizationUrl"
                  type="text"
                  value={(oauth2.authorizationUrl as string) ?? ""}
                  onChange={(e) => patchAuthSub("oauth2", { authorizationUrl: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-tokenUrl">{t("providers.form.tokenUrl")}</Label>
                <Input
                  id="pe-tokenUrl"
                  type="text"
                  value={(oauth2.tokenUrl as string) ?? ""}
                  onChange={(e) => patchAuthSub("oauth2", { tokenUrl: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-refreshUrl">{t("providers.form.refreshUrl")}</Label>
                <Input
                  id="pe-refreshUrl"
                  type="text"
                  value={(oauth2.refreshUrl as string) ?? ""}
                  onChange={(e) => patchAuthSub("oauth2", { refreshUrl: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-scopes">{t("providers.form.defaultScopes")}</Label>
                <Textarea
                  id="pe-scopes"
                  value={
                    Array.isArray(oauth2.defaultScopes)
                      ? (oauth2.defaultScopes as string[]).join("\n")
                      : ""
                  }
                  onChange={(e) =>
                    patchAuthSub("oauth2", {
                      defaultScopes: e.target.value
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  rows={3}
                />
                <div className="text-muted-foreground text-sm">
                  {t("providers.form.scopesHint")}
                </div>
              </div>

              <div className="flex gap-3">
                <div className="flex-1 space-y-1">
                  <Label htmlFor="pe-scopeSep">{t("providers.form.scopeSeparator")}</Label>
                  <Select
                    value={(oauth2.scopeSeparator as string) ?? " "}
                    onValueChange={(v) => patchAuthSub("oauth2", { scopeSeparator: v })}
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
                <div className="flex-1 space-y-1">
                  <Label htmlFor="pe-tokenAuthMethod">{t("providers.form.tokenAuthMethod")}</Label>
                  <Select
                    value={(oauth2.tokenAuthMethod as string) ?? "client_secret_post"}
                    onValueChange={(v) => patchAuthSub("oauth2", { tokenAuthMethod: v })}
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
                <div className="flex-1 space-y-1">
                  <Label htmlFor="pe-tokenContentType">
                    {t("providers.form.tokenContentType")}
                  </Label>
                  <Select
                    value={
                      (oauth2.tokenContentType as string) ?? "application/x-www-form-urlencoded"
                    }
                    onValueChange={(v) => patchAuthSub("oauth2", { tokenContentType: v })}
                  >
                    <SelectTrigger id="pe-tokenContentType">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="application/x-www-form-urlencoded">
                        {t("providers.form.tokenContentTypeForm")}
                      </SelectItem>
                      <SelectItem value="application/json">
                        {t("providers.form.tokenContentTypeJson")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="pe-pkce"
                  checked={(oauth2.pkceEnabled as boolean) ?? true}
                  onCheckedChange={(checked) =>
                    patchAuthSub("oauth2", { pkceEnabled: Boolean(checked) })
                  }
                />
                <Label
                  htmlFor="pe-pkce"
                  className="text-muted-foreground cursor-pointer text-sm font-normal"
                >
                  {t("providers.form.pkceEnabled")}
                </Label>
              </div>

              {/* Credential header config */}
              <div className="flex gap-3">
                <div className="flex-1 space-y-1">
                  <Label htmlFor="pe-credHeaderName">
                    {t("providers.form.credentialHeaderName")}
                  </Label>
                  <Input
                    id="pe-credHeaderName"
                    type="text"
                    value={(def.credentialHeaderName as string) ?? ""}
                    onChange={(e) => patchDef({ credentialHeaderName: e.target.value })}
                    placeholder="Authorization"
                  />
                </div>
                <div className="flex-1 space-y-1">
                  <Label htmlFor="pe-credHeaderPrefix">
                    {t("providers.form.credentialHeaderPrefix")}
                  </Label>
                  <Input
                    id="pe-credHeaderPrefix"
                    type="text"
                    value={(def.credentialHeaderPrefix as string) ?? ""}
                    onChange={(e) => patchDef({ credentialHeaderPrefix: e.target.value })}
                    placeholder="Bearer"
                  />
                </div>
              </div>

              {/* Available scopes editor */}
              <div className="text-muted-foreground mt-2 text-sm font-medium">
                {t("providers.form.sectionAvailableScopes")}
              </div>
              <div className="text-muted-foreground text-xs">
                {t("providers.form.availableScopesHint")}
              </div>
              {((def.availableScopes ?? []) as AvailableScope[]).map((scope, idx) => (
                <div key={idx} className="border-border bg-card rounded-md border p-2.5">
                  <div className="flex items-center gap-2">
                    <Input
                      type="text"
                      placeholder={t("providers.form.scopeValue")}
                      value={scope.value}
                      onChange={(e) => {
                        const next = [...((def.availableScopes ?? []) as AvailableScope[])];
                        next[idx] = { ...next[idx]!, value: e.target.value };
                        patchDef({ availableScopes: next });
                      }}
                      className="min-w-0 flex-[2]"
                    />
                    <Input
                      type="text"
                      placeholder={t("providers.form.scopeLabel")}
                      value={scope.label}
                      onChange={(e) => {
                        const next = [...((def.availableScopes ?? []) as AvailableScope[])];
                        next[idx] = { ...next[idx]!, label: e.target.value };
                        patchDef({ availableScopes: next });
                      }}
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        const next = ((def.availableScopes ?? []) as AvailableScope[]).filter(
                          (_, i) => i !== idx,
                        );
                        patchDef({ availableScopes: next });
                      }}
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
                className="text-muted-foreground hover:text-foreground hover:border-primary border-dashed text-xs"
                onClick={() => {
                  const next = [
                    ...((def.availableScopes ?? []) as AvailableScope[]),
                    { value: "", label: "" },
                  ];
                  patchDef({ availableScopes: next });
                }}
              >
                {t("providers.form.addAvailableScope")}
              </Button>
            </>
          )}

          {/* OAuth1 */}
          {authMode === "oauth1" && (
            <>
              <div className="text-muted-foreground text-sm font-medium">
                {t("providers.form.sectionOAuth1")}
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-requestTokenUrl">{t("providers.form.requestTokenUrl")}</Label>
                <Input
                  id="pe-requestTokenUrl"
                  type="text"
                  value={(oauth1.requestTokenUrl as string) ?? ""}
                  onChange={(e) => patchAuthSub("oauth1", { requestTokenUrl: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-authorizationUrl">{t("providers.form.authorizationUrl")}</Label>
                <Input
                  id="pe-authorizationUrl"
                  type="text"
                  value={(oauth1.authorizationUrl as string) ?? ""}
                  onChange={(e) => patchAuthSub("oauth1", { authorizationUrl: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-accessTokenUrl">{t("providers.form.accessTokenUrl")}</Label>
                <Input
                  id="pe-accessTokenUrl"
                  type="text"
                  value={(oauth1.accessTokenUrl as string) ?? ""}
                  onChange={(e) => patchAuthSub("oauth1", { accessTokenUrl: e.target.value })}
                />
              </div>
            </>
          )}

          {/* Credential schema — shared across api_key / basic / custom */}
          {isCredentialMode(authMode) && (
            <SchemaSection
              title={t("providers.form.sectionCredentials")}
              mode="credentials"
              fields={credentialFields}
              onChange={onCredentialFieldsChange}
            />
          )}

          {/* API key — sidecar injection routing (references a field from the schema above) */}
          {authMode === "api_key" && (
            <>
              <div className="text-muted-foreground text-sm font-medium">
                {t("providers.form.sectionApiKey")}
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-credFieldName">{t("providers.form.credentialFieldName")}</Label>
                <Input
                  id="pe-credFieldName"
                  type="text"
                  value={
                    ((def.credentials as Record<string, unknown> | undefined)?.fieldName as
                      | string
                      | undefined) ?? ""
                  }
                  onChange={(e) =>
                    setState((s) => ({
                      ...s,
                      manifest: {
                        ...s.manifest,
                        definition: patchCredentialsInDef(getDef(s.manifest), {
                          fieldName: toCredentialKey(e.target.value),
                        }),
                      },
                    }))
                  }
                  placeholder={credentialFields[0]?.key || "api_key"}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-credHeaderName">
                  {t("providers.form.credentialHeaderName")}
                </Label>
                <Input
                  id="pe-credHeaderName"
                  type="text"
                  value={(def.credentialHeaderName as string) ?? ""}
                  onChange={(e) => patchDef({ credentialHeaderName: e.target.value })}
                  placeholder="Authorization"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-credHeaderPrefix">
                  {t("providers.form.credentialHeaderPrefix")}
                </Label>
                <Input
                  id="pe-credHeaderPrefix"
                  type="text"
                  value={(def.credentialHeaderPrefix as string) ?? ""}
                  onChange={(e) => patchDef({ credentialHeaderPrefix: e.target.value })}
                  placeholder="Bearer "
                />
              </div>

              {/* Credential transform — template-based pre-encoding (AFPS §7.4) */}
              <div className="text-muted-foreground mt-2 text-sm font-medium">
                {t("providers.form.sectionCredentialTransform")}
              </div>
              <div className="text-muted-foreground text-xs">
                {t("providers.form.credentialTransformHint")}
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-credTransformTemplate">
                  {t("providers.form.credentialTransformTemplate")}
                </Label>
                <Textarea
                  id="pe-credTransformTemplate"
                  value={
                    ((def.credentialTransform as Record<string, unknown> | undefined)
                      ?.template as string) ?? ""
                  }
                  onChange={(e) => {
                    const template = e.target.value;
                    const prev =
                      (def.credentialTransform as Record<string, unknown> | undefined) ?? {};
                    if (!template) {
                      setState((s) => {
                        const d = { ...getDef(s.manifest) };
                        delete d.credentialTransform;
                        return { ...s, manifest: { ...s.manifest, definition: d } };
                      });
                    } else {
                      patchDef({
                        credentialTransform: {
                          ...prev,
                          template,
                          encoding: (prev.encoding as string) ?? "base64",
                        },
                      });
                    }
                  }}
                  rows={2}
                  placeholder={t("providers.form.credentialTransformTemplatePlaceholder")}
                  className="font-mono text-sm"
                />
                {credentialFields.length > 0 ? (
                  <div className="text-muted-foreground text-xs">
                    {t("providers.form.credentialTransformAvailableVars")}:{" "}
                    {credentialFields.map((f, i) => (
                      <span key={f.key}>
                        {i > 0 && ", "}
                        <code className="bg-muted rounded px-1 py-0.5">{`{{${f.key}}}`}</code>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-muted-foreground text-xs">
                    {t("providers.form.credentialTransformNoVars")}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="pe-credTransformEncoding">
                  {t("providers.form.credentialTransformEncoding")}
                </Label>
                <Select
                  value={
                    ((def.credentialTransform as Record<string, unknown> | undefined)
                      ?.encoding as string) ?? "base64"
                  }
                  onValueChange={(v) => {
                    const prev =
                      (def.credentialTransform as Record<string, unknown> | undefined) ?? {};
                    patchDef({
                      credentialTransform: {
                        ...prev,
                        template: (prev.template as string) ?? "",
                        encoding: v,
                      },
                    });
                  }}
                  disabled={!(def.credentialTransform as Record<string, unknown> | undefined)}
                >
                  <SelectTrigger id="pe-credTransformEncoding">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="base64">base64</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Authorization Tab ── */}
      {activeTab === "uris" && (
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="pe-allow-all-uris"
                checked={(def.allowAllUris as boolean) ?? false}
                onCheckedChange={(checked) => patchDef({ allowAllUris: Boolean(checked) })}
              />
              <Label
                htmlFor="pe-allow-all-uris"
                className="text-muted-foreground cursor-pointer text-sm font-normal"
              >
                {t("providers.form.allowAllUris")}
              </Label>
            </div>
            <div className="text-muted-foreground text-sm">
              {t("providers.form.allowAllUrisHint")}
            </div>
          </div>

          {!(def.allowAllUris as boolean) && (
            <div className="space-y-2">
              <Label htmlFor="pe-uris">{t("providers.form.authorizedUris")}</Label>
              <Textarea
                id="pe-uris"
                value={
                  Array.isArray(def.authorizedUris)
                    ? (def.authorizedUris as string[]).join("\n")
                    : ""
                }
                onChange={(e) =>
                  patchDef({
                    authorizedUris: e.target.value
                      .split("\n")
                      .map((u) => u.trim())
                      .filter(Boolean),
                  })
                }
                rows={5}
                placeholder="https://api.example.com/*"
              />
              <div className="text-muted-foreground text-sm">
                {t("providers.form.authorizedUrisHint")}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Content Tab ── */}
      {activeTab === "content" && (
        <ContentEditor
          value={state.content}
          onChange={(content) => setState((s) => ({ ...s, content }))}
          language="markdown"
        />
      )}

      {/* ── JSON Tab ── */}
      {activeTab === "json" && (
        <JsonEditor
          key={jsonEditorKey}
          value={state.manifest}
          onApply={(manifest) => {
            const migratedDef = migrateLegacyFieldName(getDef(manifest));
            const canonical = { ...manifest, definition: migratedDef };
            setState((s) => ({ ...s, manifest: canonical }));
            // Sync credential fields from the migrated definition
            const creds = migratedDef.credentials as { schema?: JSONSchemaObject } | undefined;
            setCredentialFields(creds?.schema ? schemaToFields(creds.schema, "credentials") : []);
            setActiveTab("general");
          }}
          schema={{ uri: AFPS_SCHEMA_URLS.provider, schema: providerSchema }}
        />
      )}

      <UnsavedChangesModal blocker={blocker} onSaveDraft={isEdit ? saveDraft : undefined} />
    </EditorShell>
  );
}
