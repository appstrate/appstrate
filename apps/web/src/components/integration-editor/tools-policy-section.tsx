// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Plus } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { SectionCard } from "../section-card";
import { StringListInput } from "./string-list-input";
import {
  getAllowUndeclaredTools,
  getAuths,
  getToolsPolicy,
  setAllowUndeclaredTools,
  setToolsPolicy,
  type ToolPolicyState,
} from "./utils";

interface ToolsPolicySectionProps {
  manifest: Record<string, unknown>;
  onChange: (manifest: Record<string, unknown>) => void;
}

export function ToolsPolicySection({ manifest, onChange }: ToolsPolicySectionProps) {
  const { t } = useTranslation(["agents", "common"]);
  // Local row state preserves in-progress rows (empty tool name) that
  // setToolsPolicy drops from the manifest — without it, "Add" would write a
  // nameless entry, the manifest would skip it, and no row would render.
  // Initialised once per mount; the tab unmounts on switch, so an external
  // JSON-tab edit is picked up on remount.
  const [rows, setRows] = useState<ToolPolicyState[]>(() => getToolsPolicy(manifest));
  const auths = getAuths(manifest);
  const authKeys = auths.map((a) => a.key);
  const allowUndeclared = getAllowUndeclaredTools(manifest);
  // AFPS §7.8 — the wildcard opt-in requires ≥1 "wildcard-usable" auth:
  // either a non-oauth2 auth (api_key/basic/custom/mtls — no scope mechanism,
  // the wholesale grant covers any tool) or an oauth2 auth with non-empty
  // `default_scopes`. The schema enforces this at save; surface the gate in
  // the UI so the toggle is visibly disabled rather than rejected later.
  const hasWildcardUsableAuth = auths.some(
    (a) => a.type !== "oauth2" || a.defaultScopes.length > 0,
  );

  const commit = (next: ToolPolicyState[]) => {
    setRows(next);
    onChange(setToolsPolicy(manifest, next));
  };
  const onAllowUndeclaredChange = (next: boolean) => {
    onChange(setAllowUndeclaredTools(manifest, next));
  };
  const update = (idx: number, patch: Partial<ToolPolicyState>) =>
    commit(rows.map((p, i) => (i === idx ? { ...p, ...patch } : p)));

  const setAuthScopes = (idx: number, authKey: string, scopes: string[]) =>
    update(idx, { requiredScopes: { ...rows[idx]!.requiredScopes, [authKey]: scopes } });

  const addPolicy = () => commit([...rows, { name: "", requiredScopes: {} }]);

  return (
    <SectionCard
      title={t("integrationEditor.toolsPolicy.title")}
      headerRight={
        <Button type="button" size="sm" variant="outline" onClick={addPolicy}>
          <Plus size={14} />
          {t("integrationEditor.toolsPolicy.add")}
        </Button>
      }
    >
      <p className="text-muted-foreground text-sm">{t("integrationEditor.toolsPolicy.help")}</p>

      <div className="border-border bg-muted/30 rounded-md border border-dashed p-3">
        <label
          className={`flex items-start gap-2 ${
            hasWildcardUsableAuth || allowUndeclared
              ? "cursor-pointer"
              : "cursor-not-allowed opacity-60"
          }`}
          data-testid="integration-editor-allow-undeclared-tools"
        >
          <Checkbox
            checked={allowUndeclared}
            disabled={!hasWildcardUsableAuth && !allowUndeclared}
            onCheckedChange={(v) => onAllowUndeclaredChange(v === true)}
            className="mt-0.5"
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">
              {t("integrationEditor.allowUndeclaredTools.label")}
            </span>
            <span className="text-muted-foreground text-xs">
              {t("integrationEditor.allowUndeclaredTools.description")}
            </span>
            {!hasWildcardUsableAuth && (
              <span className="text-destructive text-xs">
                {t("integrationEditor.allowUndeclaredTools.requiresWildcardUsableAuth")}
              </span>
            )}
          </span>
        </label>
      </div>

      {rows.map((policy, idx) => (
        <div key={idx} className="border-border space-y-3 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Label htmlFor={`tp-name-${idx}`}>
                {t("integrationEditor.toolsPolicy.toolName")}
              </Label>
              <Input
                id={`tp-name-${idx}`}
                value={policy.name}
                onChange={(e) => update(idx, { name: e.target.value })}
                placeholder="list_issues"
                className="mt-1 font-mono"
              />
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="mt-5"
              onClick={() => commit(rows.filter((_, i) => i !== idx))}
            >
              <Trash2 size={14} className="text-destructive" />
            </Button>
          </div>

          <div className="space-y-2">
            <Label>{t("integrationEditor.toolsPolicy.requiredScopes")}</Label>
            <p className="text-muted-foreground text-xs">
              {t("integrationEditor.toolsPolicy.requiredScopesDesc")}
            </p>
            {authKeys.length === 0 ? (
              <p className="text-muted-foreground text-xs italic">
                {t("integrationEditor.toolsPolicy.noAuths")}
              </p>
            ) : (
              authKeys.map((k) => (
                <StringListInput
                  key={k}
                  label={k}
                  values={policy.requiredScopes[k] ?? []}
                  onChange={(scopes) => setAuthScopes(idx, k, scopes)}
                  placeholder="read"
                />
              ))
            )}
          </div>
        </div>
      ))}
    </SectionCard>
  );
}
