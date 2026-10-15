// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Plus } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Input } from "@appstrate/ui/components/input";
import { FormItem } from "@/components/app-ui/form-item";
import { EditorSection, type EditorSurface } from "./editor-section";
import { RequiredScopesField } from "./required-scopes-field";
import {
  getAllowUndeclaredTools,
  getAuths,
  getToolsPolicy,
  setAllowUndeclaredTools,
  setToolsPolicy,
  type ToolPolicyState,
} from "./utils";

interface ToolsPolicySectionProps {
  /** `settings` inside the edit panel, `card` on the editor page. */
  surface?: EditorSurface;
  manifest: Record<string, unknown>;
  onChange: (manifest: Record<string, unknown>) => void;
}

export function ToolsPolicySection({
  manifest,
  onChange,
  surface = "card",
}: ToolsPolicySectionProps) {
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

  const addPolicy = () => commit([...rows, { name: "", requiredScopes: {} }]);

  return (
    <EditorSection
      surface={surface}
      title={t("integrationEditor.toolsPolicy.title")}
      headerRight={
        <Button type="button" size="sm" variant="outline" onClick={addPolicy}>
          <Plus />
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
        <div key={idx} className="border-border flex flex-col gap-3 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <FormItem
              id={`tp-name-${idx}`}
              label={t("integrationEditor.toolsPolicy.toolName")}
              className="flex-1"
            >
              <Input
                value={policy.name}
                onChange={(e) => update(idx, { name: e.target.value })}
                placeholder="list_issues"
                className="font-mono"
              />
            </FormItem>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="mt-7"
              onClick={() => commit(rows.filter((_, i) => i !== idx))}
            >
              <Trash2 className="text-destructive" />
            </Button>
          </div>

          <RequiredScopesField
            authKeys={authKeys}
            value={policy.requiredScopes}
            onChange={(requiredScopes) => update(idx, { requiredScopes })}
          />
        </div>
      ))}
    </EditorSection>
  );
}
