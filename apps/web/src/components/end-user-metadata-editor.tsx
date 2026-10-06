// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";

import type { MetadataEntry } from "../lib/end-user-metadata";

/** Key/value rows for an end-user's `metadata` — shared by the create and edit forms. */
export function EndUserMetadataEditor({
  entries,
  onChange,
}: {
  entries: MetadataEntry[];
  onChange: (entries: MetadataEntry[]) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <div className="space-y-2">
      <Label>{t("spaces.metadata")}</Label>
      <div className="space-y-2">
        {entries.map((entry, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              value={entry.key}
              onChange={(e) =>
                onChange(entries.map((x, i) => (i === index ? { ...x, key: e.target.value } : x)))
              }
              placeholder={t("spaces.metadataKey")}
              aria-label={t("spaces.metadataKey")}
              className="flex-1"
            />
            <Input
              value={entry.value}
              onChange={(e) =>
                onChange(entries.map((x, i) => (i === index ? { ...x, value: e.target.value } : x)))
              }
              placeholder={t("spaces.metadataValue")}
              aria-label={t("spaces.metadataValue")}
              className="flex-1"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-label={t("common:btn.delete")}
              onClick={() => onChange(entries.filter((_, i) => i !== index))}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...entries, { key: "", value: "" }])}
      >
        <Plus size={14} className="mr-1" />
        {t("spaces.addMetadataKey")}
      </Button>
    </div>
  );
}
