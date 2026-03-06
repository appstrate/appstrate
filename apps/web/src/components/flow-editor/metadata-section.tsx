import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "../form-field";
import { toSlug, toLiveSlug } from "../../lib/strings";

interface MetadataState {
  id: string;
  scope: string;
  version: string;
  displayName: string;
  description: string;
  author: string;
  tags: string[];
}

interface MetadataSectionProps {
  value: MetadataState;
  onChange: (value: MetadataState) => void;
  isEdit: boolean;
}

export function MetadataSection({ value, onChange, isEdit }: MetadataSectionProps) {
  const { t } = useTranslation(["flows", "common"]);
  const update = (patch: Partial<MetadataState>) => onChange({ ...value, ...patch });
  const [nameEdited, setNameEdited] = useState(isEdit);

  const handleDisplayNameChange = (v: string) => {
    if (nameEdited) {
      update({ displayName: v });
    } else {
      update({ displayName: v, id: toSlug(v) });
    }
  };

  const handleTagInput = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const input = e.currentTarget;
      const tag = input.value.trim().replace(/,$/g, "");
      if (tag && !value.tags.includes(tag)) {
        update({ tags: [...value.tags, tag] });
      }
      input.value = "";
    }
  };

  const removeTag = (tag: string) => {
    update({ tags: value.tags.filter((t) => t !== tag) });
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card mb-4">
      <div className="bg-background px-4 py-3 text-xs font-semibold uppercase tracking-wide text-foreground border-b border-border">
        {t("editor.metadata")}
      </div>
      <div className="space-y-3 p-4">
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
          <Label>{t("editor.metaTags")}</Label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {value.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-0.5 text-xs text-muted-foreground"
              >
                {tag}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-auto w-auto p-0 text-muted-foreground hover:text-destructive text-sm leading-none"
                  onClick={() => removeTag(tag)}
                >
                  &times;
                </Button>
              </span>
            ))}
          </div>
          <Input
            type="text"
            placeholder={t("editor.metaTagPlaceholder")}
            onKeyDown={handleTagInput}
          />
        </div>
      </div>
    </div>
  );
}
