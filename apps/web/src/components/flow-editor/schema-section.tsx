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

type SchemaMode = "input" | "output" | "config" | "state";

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
    ...(mode === "state" ? { format: "" } : {}),
  };
}

export function SchemaSection({ title, mode, fields, onChange }: SchemaSectionProps) {
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
              placeholder="cle"
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
            {mode !== "state" && (
              <input
                type="text"
                placeholder="description"
                value={field.description}
                onChange={(e) => update(i, { description: e.target.value })}
                className="field-row-grow"
              />
            )}
            {mode !== "state" && (
              <label className="field-checkbox">
                <input
                  type="checkbox"
                  checked={field.required}
                  onChange={(e) => update(i, { required: e.target.checked })}
                />
                req
              </label>
            )}
            {mode === "state" && (
              <input
                type="text"
                placeholder="format (ex: date-time)"
                value={field.format ?? ""}
                onChange={(e) => update(i, { format: e.target.value })}
                className="field-row-grow"
              />
            )}
            {(mode === "input" || mode === "config") && (
              <input
                type="text"
                placeholder="defaut"
                value={field.default ?? ""}
                onChange={(e) => update(i, { default: e.target.value })}
              />
            )}
            {mode === "input" && (
              <input
                type="text"
                placeholder="placeholder"
                value={field.placeholder ?? ""}
                onChange={(e) => update(i, { placeholder: e.target.value })}
              />
            )}
            {mode === "config" && (
              <input
                type="text"
                placeholder="enum (virgule)"
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
          + Ajouter un champ
        </button>
      </div>
    </div>
  );
}
