// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "../form-field";
import { SectionCard } from "../section-card";
import { toSlug, toLiveSlug } from "../../lib/strings";

export interface MetadataState {
  id: string;
  scope: string;
  version: string;
  displayName: string;
  description: string;
  author: string;
  keywords: string[];
  timeout?: number;
}

interface MetadataSectionProps {
  value: MetadataState;
  onChange: (value: MetadataState) => void;
  isEdit: boolean;
}

export function MetadataSection({ value, onChange, isEdit }: MetadataSectionProps) {
  const { t } = useTranslation(["agents", "common"]);
  const update = (patch: Partial<MetadataState>) => onChange({ ...value, ...patch });
  const [nameEdited, setNameEdited] = useState(isEdit);

  const handleKeywordInput = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const input = e.currentTarget;
      const keyword = input.value.trim().replace(/,$/g, "");
      if (keyword && !value.keywords.includes(keyword)) {
        update({ keywords: [...value.keywords, keyword] });
      }
      input.value = "";
    }
  };

  const removeKeyword = (keyword: string) => {
    update({ keywords: value.keywords.filter((k) => k !== keyword) });
  };

  const handleDisplayNameChange = (v: string) => {
    if (nameEdited) {
      update({ displayName: v });
    } else {
      update({ displayName: v, id: toSlug(v) });
    }
  };

  return (
    <SectionCard title={t("editor.metadata")}>
      <FormField
        id="meta-displayName"
        label={t("editor.metaDisplayName")}
        required
        value={value.displayName}
        onChange={handleDisplayNameChange}
        placeholder={t("editor.metaDisplayNamePlaceholder")}
      />
      <FormField
        id="meta-name"
        label={t("editor.metaName")}
        required
        value={value.id}
        onChange={(v) => {
          setNameEdited(true);
          update({ id: toLiveSlug(v) });
        }}
        onBlur={() => update({ id: toSlug(value.id) })}
        placeholder={t("editor.metaNamePlaceholder")}
        description={isEdit ? t("editor.metaNameEditDesc") : t("editor.metaNameDesc")}
      />
      {isEdit && <input type="hidden" value={value.id} />}
      <FormField
        id="meta-scope"
        label={t("editor.metaScope")}
        value={value.scope}
        onChange={() => {}}
        description={t("editor.metaScopeDesc")}
        disabled
      />
      <FormField
        id="meta-version"
        label={t("editor.metaVersion")}
        required
        value={value.version}
        onChange={(v) => update({ version: v })}
        placeholder="1.0.0"
        description={t("editor.metaVersionDesc")}
      />
      {value.timeout !== undefined && (
        <FormField
          id="meta-timeout"
          label={t("editor.execTimeout")}
          type="number"
          value={String(value.timeout)}
          onChange={(v) => update({ timeout: parseInt(v) || 300 })}
          description={t("editor.execTimeoutDesc")}
        />
      )}
      <div className="space-y-2">
        <Label htmlFor="meta-description">{t("editor.metaDescription")}</Label>
        <Textarea
          id="meta-description"
          value={value.description}
          onChange={(e) => update({ description: e.target.value })}
          placeholder={t("editor.metaDescPlaceholder")}
        />
      </div>
      <div className="space-y-2">
        <Label>{t("editor.metaKeywords")}</Label>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {value.keywords.map((keyword) => (
            <span
              key={keyword}
              className="border-border bg-background text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs"
            >
              {keyword}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-destructive h-auto w-auto p-0 text-sm leading-none"
                onClick={() => removeKeyword(keyword)}
              >
                &times;
              </Button>
            </span>
          ))}
        </div>
        <Input
          type="text"
          placeholder={t("editor.metaKeywordPlaceholder")}
          onKeyDown={handleKeywordInput}
        />
      </div>
    </SectionCard>
  );
}
