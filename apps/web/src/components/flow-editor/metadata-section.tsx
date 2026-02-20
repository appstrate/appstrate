import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FormField } from "../form-field";
import { toSlug } from "../../lib/strings";

interface MetadataState {
  name: string;
  displayName: string;
  description: string;
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
      update({ displayName: v, name: toSlug(v) });
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
    <div className="editor-section">
      <div className="editor-section-header">{t("editor.metadata")}</div>
      <div className="editor-section-body">
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
          value={value.name}
          onChange={(v) => {
            setNameEdited(true);
            update({
              name: v
                .toLowerCase()
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .replace(/[^a-z0-9-]/g, "-"),
            });
          }}
          placeholder={t("editor.metaNamePlaceholder")}
          description={isEdit ? t("editor.metaNameEditDesc") : t("editor.metaNameDesc")}
        />
        {isEdit && <input type="hidden" value={value.name} />}
        <div className="form-group">
          <label htmlFor="meta-description">{t("editor.metaDescription")}</label>
          <textarea
            id="meta-description"
            value={value.description}
            onChange={(e) => update({ description: e.target.value })}
            placeholder={t("editor.metaDescPlaceholder")}
          />
        </div>
        <div className="form-group">
          <label>{t("editor.metaTags")}</label>
          <div className="tag-chips">
            {value.tags.map((tag) => (
              <span key={tag} className="tag-chip">
                {tag}
                <button type="button" className="btn-remove-inline" onClick={() => removeTag(tag)}>
                  &times;
                </button>
              </span>
            ))}
          </div>
          <input
            type="text"
            placeholder={t("editor.metaTagPlaceholder")}
            onKeyDown={handleTagInput}
          />
        </div>
      </div>
    </div>
  );
}
