// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { FormField } from "../form-field";
import { SectionCard } from "../section-card";
import { StringListInput } from "./string-list-input";
import {
  getAuths,
  setAuths,
  emptyAuth,
  type AuthState,
  type AuthType,
  type ScopeCatalogEntry,
} from "./utils";

interface AuthsSectionProps {
  manifest: Record<string, unknown>;
  onChange: (manifest: Record<string, unknown>) => void;
}

const AUTH_TYPES: AuthType[] = ["api_key", "oauth2", "basic", "custom"];

export function AuthsSection({ manifest, onChange }: AuthsSectionProps) {
  const { t } = useTranslation(["agents", "common"]);
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
    <SectionCard
      title={t("integrationEditor.auths.title")}
      headerRight={
        <Button type="button" size="sm" variant="outline" onClick={addAuth}>
          <Plus size={14} />
          {t("integrationEditor.auths.add")}
        </Button>
      }
    >
      {rows.length === 0 && (
        <p className="text-muted-foreground text-sm">{t("integrationEditor.auths.empty")}</p>
      )}

      {rows.map((auth, idx) => (
        <div key={idx} className="border-border space-y-3 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Label htmlFor={`auth-key-${idx}`}>{t("integrationEditor.auths.key")}</Label>
              <Input
                id={`auth-key-${idx}`}
                value={auth.key}
                onChange={(e) => updateAuth(idx, { key: e.target.value })}
                placeholder="primary"
                className="mt-1 font-mono"
              />
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="mt-5"
              onClick={() => removeAuth(idx)}
              title={t("btn.delete", { ns: "common" })}
            >
              <Trash2 size={14} className="text-destructive" />
            </Button>
          </div>

          <FormField
            id={`auth-type-${idx}`}
            label={t("integrationEditor.auths.type")}
            value={auth.type}
            onChange={(v) => updateAuth(idx, { type: v as AuthType })}
            enumValues={AUTH_TYPES}
          />

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={auth.allowAllUris}
              onCheckedChange={(c) => updateAuth(idx, { allowAllUris: Boolean(c) })}
            />
            {t("integrationEditor.auths.allowAllUris")}
          </label>

          {!auth.allowAllUris && (
            <StringListInput
              label={t("integrationEditor.auths.authorizedUris")}
              values={auth.authorizedUris}
              onChange={(authorizedUris) => updateAuth(idx, { authorizedUris })}
              placeholder="https://api.example.com/**"
              description={t("integrationEditor.auths.authorizedUrisDesc")}
            />
          )}

          {/* Credential delivery (HTTP header injection) */}
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

          {auth.type === "oauth2" ? (
            <div className="space-y-3">
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
                <p
                  className="text-destructive text-xs"
                  data-testid={`auth-default-scopes-wildcard-warning-${auth.key}`}
                >
                  {t("integrationEditor.auths.defaultScopesRequiredForWildcard")}
                </p>
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
    </SectionCard>
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
  const update = (i: number, patch: Partial<ScopeCatalogEntry>) =>
    onChange(entries.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{t("integrationEditor.auths.scopeCatalog")}</Label>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onChange([...entries, { value: "" }])}
        >
          <Plus size={14} />
          {t("integrationEditor.auths.scopeAdd")}
        </Button>
      </div>
      {entries.map((entry, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={entry.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder={t("integrationEditor.auths.scopeValue")}
            className="font-mono"
          />
          <Input
            value={entry.label ?? ""}
            onChange={(e) => update(i, { label: e.target.value || undefined })}
            placeholder={t("integrationEditor.auths.scopeLabel")}
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => onChange(entries.filter((_, idx) => idx !== i))}
          >
            <Trash2 size={14} className="text-destructive" />
          </Button>
        </div>
      ))}
    </div>
  );
}
