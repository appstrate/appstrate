// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionCard } from "../section-card";
import { StringListInput } from "./string-list-input";
import { getToolsPolicy, setToolsPolicy, getAuths, type ToolPolicyState } from "./utils";

interface ToolsPolicySectionProps {
  manifest: Record<string, unknown>;
  onChange: (manifest: Record<string, unknown>) => void;
}

// Radix Select forbids an empty-string item value — sentinel for "no auth key".
const NONE_AUTH_KEY = "__none__";

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

  const addPolicy = () =>
    commit([...rows, { name: "", requiredAuthKey: "", requiredScopes: [], urlPatterns: [] }]);

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

          <div className="space-y-1">
            <Label htmlFor={`tp-authkey-${idx}`}>
              {t("integrationEditor.toolsPolicy.requiredAuthKey")}
            </Label>
            <Select
              value={policy.requiredAuthKey || NONE_AUTH_KEY}
              onValueChange={(v) => update(idx, { requiredAuthKey: v === NONE_AUTH_KEY ? "" : v })}
            >
              <SelectTrigger id={`tp-authkey-${idx}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_AUTH_KEY}>
                  {t("integrationEditor.toolsPolicy.authKeyNone")}
                </SelectItem>
                {authKeys.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              {t("integrationEditor.toolsPolicy.requiredAuthKeyDesc")}
            </p>
          </div>

          <StringListInput
            label={t("integrationEditor.toolsPolicy.requiredScopes")}
            values={policy.requiredScopes}
            onChange={(requiredScopes) => update(idx, { requiredScopes })}
            placeholder="read"
          />

          <StringListInput
            label={t("integrationEditor.toolsPolicy.urlPatterns")}
            values={policy.urlPatterns}
            onChange={(urlPatterns) => update(idx, { urlPatterns })}
            placeholder="https://api.example.com/issues/**"
            description={t("integrationEditor.toolsPolicy.urlPatternsDesc")}
          />
        </div>
      ))}
    </SectionCard>
  );
}
