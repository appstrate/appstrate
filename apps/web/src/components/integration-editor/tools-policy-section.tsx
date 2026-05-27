// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "../section-card";
import { StringListInput } from "./string-list-input";
import { getToolsPolicy, setToolsPolicy, getAuths, type ToolPolicyState } from "./utils";

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
  const authKeys = getAuths(manifest).map((a) => a.key);

  const commit = (next: ToolPolicyState[]) => {
    setRows(next);
    onChange(setToolsPolicy(manifest, next));
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
