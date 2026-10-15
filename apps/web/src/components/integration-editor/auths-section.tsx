// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Plus } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { CheckboxField } from "@/components/app-ui/checkbox-field";
import { FieldError } from "@appstrate/ui/components/field";
import { FormItem } from "@/components/app-ui/form-item";
import { Label } from "@appstrate/ui/components/label";
import { FormField } from "../form-field";
import { RowsEditor } from "../rows-editor";
import { EditorSection, type EditorSurface } from "./editor-section";
import { StringListInput } from "./string-list-input";
import {
  getAuths,
  setAuths,
  emptyAuth,
  AUTH_TYPES,
  type AuthState,
  type AuthType,
  type ScopeCatalogEntry,
} from "./utils";

interface AuthsSectionProps {
  /** `settings` inside the edit panel, `card` on the editor page. */
  surface?: EditorSurface;
  manifest: Record<string, unknown>;
  onChange: (manifest: Record<string, unknown>) => void;
}

export function AuthsSection({ manifest, onChange, surface = "card" }: AuthsSectionProps) {
  const { t } = useTranslation(["agents", "common", "settings"]);
  // Local row state preserves in-progress rows (e.g. a momentarily-empty key)
  // that setAuths drops from the manifest. Initialised once per mount; the tab
  // unmounts on switch, so an external JSON-tab edit is picked up on remount.
  const [rows, setRows] = useState<AuthState[]>(() => getAuths(manifest));
  // AFPS §7.8 — when `allow_undeclared_tools: true` is set on the manifest,
  // at least one auth MUST be "wildcard-usable": non-oauth2 (no scope
  // mechanism — always usable) or oauth2 with non-empty `default_scopes`.
  // Surface the gate inline only when no auth currently qualifies, on the
  // oauth2 row(s) where the user actually has a fix (add `default_scopes`).
  const wildcardEnabled = manifest.allow_undeclared_tools === true;
  const hasWildcardUsableAuth = rows.some((r) => r.type !== "oauth2" || r.defaultScopes.length > 0);

  const commit = (next: AuthState[]) => {
    setRows(next);
    onChange(setAuths(manifest, next));
  };

  const updateAuth = (idx: number, patch: Partial<AuthState>) => {
    commit(rows.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  };

  const addAuth = () => {
    const existing = new Set(rows.map((a) => a.key));
    let key = "primary";
    let n = 2;
    while (existing.has(key)) key = `auth${n++}`;
    commit([...rows, emptyAuth(key)]);
  };

  const removeAuth = (idx: number) => commit(rows.filter((_, i) => i !== idx));

  return (
    <EditorSection
      surface={surface}
      title={t("integrationEditor.auths.title")}
      headerRight={
        <Button type="button" size="sm" variant="outline" onClick={addAuth}>
          <Plus />
          {t("integrationEditor.auths.add")}
        </Button>
      }
    >
      {rows.length === 0 && (
        <p className="text-muted-foreground text-sm">{t("integrationEditor.auths.empty")}</p>
      )}

      {rows.map((auth, idx) => (
        <div key={idx} className="border-border flex flex-col gap-3 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <FormItem
              id={`auth-key-${idx}`}
              label={t("integrationEditor.auths.key")}
              className="flex-1"
            >
              <Input
                value={auth.key}
                onChange={(e) => updateAuth(idx, { key: e.target.value })}
                placeholder="primary"
                className="font-mono"
              />
            </FormItem>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="mt-7"
              onClick={() => removeAuth(idx)}
              title={t("btn.delete", { ns: "common" })}
            >
              <Trash2 className="text-destructive" />
            </Button>
          </div>

          <FormField
            id={`auth-type-${idx}`}
            label={t("integrationEditor.auths.type")}
            value={auth.type}
            onChange={(v) =>
              updateAuth(idx, {
                type: v as AuthType,
                // AFPS §7.2 + §7.6: `mtls` cannot ride `delivery.http`.
                ...(v === "mtls" ? { deliveryHeaderName: "" } : {}),
              })
            }
            enumValues={[...AUTH_TYPES]}
            enumLabel={(v) => t(`settings:integration.auth.type.${v}`)}
          />

          <CheckboxField
            id={`auth-all-uris-${idx}`}
            label={t("integrationEditor.auths.allowAllUris")}
            checked={auth.allowAllUris}
            onCheckedChange={(c) => updateAuth(idx, { allowAllUris: Boolean(c) })}
          />

          {!auth.allowAllUris && (
            <StringListInput
              label={t("integrationEditor.auths.authorizedUris")}
              values={auth.authorizedUris}
              onChange={(authorizedUris) => updateAuth(idx, { authorizedUris })}
              placeholder="https://api.example.com/**"
              description={t("integrationEditor.auths.authorizedUrisDesc")}
            />
          )}

          {/* api_call tool opt-in (`_meta["dev.appstrate/api"].auths[key]`) */}
          <CheckboxField
            id={`auth-api-call-${idx}`}
            label={t("integrationEditor.auths.apiCall")}
            description={t("integrationEditor.auths.apiCallDesc")}
            checked={auth.apiCallEnabled}
            onCheckedChange={(c) => updateAuth(idx, { apiCallEnabled: Boolean(c) })}
            data-testid={`auth-api-call-${auth.key}`}
          />

          {/* Credential delivery (HTTP header injection) */}
          {auth.type === "mtls" ? (
            <p className="text-muted-foreground text-xs">
              {t("integrationEditor.auths.mtlsDelivery")}
            </p>
          ) : (
            <div className="border-border space-y-2 rounded border border-dashed p-2">
              <Label className="text-xs uppercase">{t("integrationEditor.auths.delivery")}</Label>
              <FormField
                id={`auth-hdr-name-${idx}`}
                label={t("integrationEditor.auths.headerName")}
                value={auth.deliveryHeaderName}
                onChange={(v) => updateAuth(idx, { deliveryHeaderName: v })}
                placeholder="Authorization"
              />
              <FormField
                id={`auth-hdr-prefix-${idx}`}
                label={t("integrationEditor.auths.headerPrefix")}
                value={auth.deliveryHeaderPrefix}
                onChange={(v) => updateAuth(idx, { deliveryHeaderPrefix: v })}
                placeholder="Bearer "
              />
              <FormField
                id={`auth-hdr-value-${idx}`}
                label={t("integrationEditor.auths.headerValue")}
                value={auth.deliveryHeaderValue}
                onChange={(v) => updateAuth(idx, { deliveryHeaderValue: v })}
                placeholder="{$credential.api_key}"
                description={t("integrationEditor.auths.headerValueDesc")}
              />
            </div>
          )}

          {auth.type === "oauth2" ? (
            <div className="flex flex-col gap-3">
              <FormField
                id={`auth-authz-${idx}`}
                label={t("integrationEditor.auths.authorizationEndpoint")}
                type="url"
                value={auth.authorizationEndpoint}
                onChange={(v) => updateAuth(idx, { authorizationEndpoint: v })}
                placeholder="https://example.com/oauth/authorize"
              />
              <FormField
                id={`auth-token-${idx}`}
                label={t("integrationEditor.auths.tokenEndpoint")}
                type="url"
                value={auth.tokenEndpoint}
                onChange={(v) => updateAuth(idx, { tokenEndpoint: v })}
                placeholder="https://example.com/oauth/token"
              />
              <StringListInput
                label={t("integrationEditor.auths.defaultScopes")}
                values={auth.defaultScopes}
                onChange={(defaultScopes) => updateAuth(idx, { defaultScopes })}
                placeholder="read"
              />
              {wildcardEnabled && !hasWildcardUsableAuth && (
                <FieldError data-testid={`auth-default-scopes-wildcard-warning-${auth.key}`}>
                  {t("integrationEditor.auths.defaultScopesRequiredForWildcard")}
                </FieldError>
              )}
              <ScopeCatalogEditor
                entries={auth.scopeCatalog}
                onChange={(scopeCatalog) => updateAuth(idx, { scopeCatalog })}
              />
            </div>
          ) : (
            <StringListInput
              label={t("integrationEditor.auths.credentialFields")}
              values={auth.credentialFields}
              onChange={(credentialFields) => updateAuth(idx, { credentialFields })}
              placeholder="api_key"
              description={t("integrationEditor.auths.credentialFieldsDesc")}
            />
          )}
        </div>
      ))}
    </EditorSection>
  );
}

function ScopeCatalogEditor({
  entries,
  onChange,
}: {
  entries: ScopeCatalogEntry[];
  onChange: (entries: ScopeCatalogEntry[]) => void;
}) {
  const { t } = useTranslation(["agents", "common"]);

  return (
    <RowsEditor
      label={t("integrationEditor.auths.scopeCatalog")}
      rows={entries}
      onChange={onChange}
      newRow={{ value: "" }}
      addLabel={t("integrationEditor.auths.scopeAdd")}
      renderRow={(entry, update) => (
        <>
          <Input
            value={entry.value}
            onChange={(e) => update({ ...entry, value: e.target.value })}
            placeholder={t("integrationEditor.auths.scopeValue")}
            className="font-mono"
          />
          <Input
            value={entry.label ?? ""}
            onChange={(e) => update({ ...entry, label: e.target.value || undefined })}
            placeholder={t("integrationEditor.auths.scopeLabel")}
          />
        </>
      )}
    />
  );
}
