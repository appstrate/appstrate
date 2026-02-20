import { useTranslation } from "react-i18next";

export interface SchemaField {
  key: string;
  type: string;
  description: string;
  required: boolean;
  placeholder?: string;
  default?: string;
  enumValues?: string;
  format?: string;
}

type SchemaMode = "input" | "output" | "config";

interface SchemaSectionProps {
  title: string;
  mode: SchemaMode;
  fields: SchemaField[];
  onChange: (fields: SchemaField[]) => void;
}

const TYPE_OPTIONS = ["string", "number", "boolean", "array", "object"];

function emptyField(mode: SchemaMode): SchemaField {
  return {
    key: "",
    type: "string",
    description: "",
    required: false,
    ...(mode === "input" ? { placeholder: "", default: "" } : {}),
    ...(mode === "config" ? { default: "", enumValues: "" } : {}),
  };
}

export function SchemaSection({ title, mode, fields, onChange }: SchemaSectionProps) {
  const { t } = useTranslation(["flows", "common"]);
  const add = () => onChange([...fields, emptyField(mode)]);

  const update = (index: number, patch: Partial<SchemaField>) => {
    const next = fields.map((f, i) => (i === index ? { ...f, ...patch } : f));
    onChange(next);
  };

  const remove = (index: number) => {
    onChange(fields.filter((_, i) => i !== index));
  };

  return (
    <div className="editor-section">
      <div className="editor-section-header">{title}</div>
      <div className="editor-section-body">
        {fields.map((field, i) => (
          <div key={i} className="field-row">
            <input
              type="text"
              placeholder={t("editor.fieldKey")}
              value={field.key}
              onChange={(e) => update(i, { key: e.target.value })}
              className="field-key"
            />
            <select value={field.type} onChange={(e) => update(i, { type: e.target.value })}>
              {TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder={t("editor.fieldDesc")}
              value={field.description}
              onChange={(e) => update(i, { description: e.target.value })}
              className="field-row-grow"
            />
            <label className="field-checkbox">
              <input
                type="checkbox"
                checked={field.required}
                onChange={(e) => update(i, { required: e.target.checked })}
              />
              {t("editor.fieldReq")}
            </label>
            {(mode === "input" || mode === "config") && (
              <input
                type="text"
                placeholder={t("editor.fieldDefault")}
                value={field.default ?? ""}
                onChange={(e) => update(i, { default: e.target.value })}
              />
            )}
            {mode === "input" && (
              <input
                type="text"
                placeholder={t("editor.fieldPlaceholder")}
                value={field.placeholder ?? ""}
                onChange={(e) => update(i, { placeholder: e.target.value })}
              />
            )}
            {mode === "config" && (
              <input
                type="text"
                placeholder={t("editor.fieldEnum")}
                value={field.enumValues ?? ""}
                onChange={(e) => update(i, { enumValues: e.target.value })}
              />
            )}
            <button type="button" className="btn-remove" onClick={() => remove(i)}>
              &times;
            </button>
          </div>
        ))}
        <button type="button" className="add-field-btn" onClick={add}>
          {t("editor.addField")}
        </button>
      </div>
    </div>
  );
}
