export interface FormFieldProps {
  id: string;
  label: string;
  required?: boolean;
  type?: "text" | "number";
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  description?: string;
  enumValues?: string[];
  error?: string;
  disabled?: boolean;
}

export function FormField({
  id,
  label,
  required,
  type = "text",
  value,
  onChange,
  onBlur,
  placeholder,
  description,
  enumValues,
  error,
  disabled,
}: FormFieldProps) {
  const hintId = description ? `hint-${id}` : undefined;
  const errorId = error ? `error-${id}` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="form-group">
      <label htmlFor={id}>
        {label}
        {required ? " *" : ""}
      </label>
      {enumValues ? (
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={error ? "input-error" : undefined}
        >
          {enumValues.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={error ? "input-error" : undefined}
        />
      )}
      {description && (
        <div id={hintId} className="hint">
          {description}
        </div>
      )}
      {error && (
        <div id={errorId} className="field-error">
          {error}
        </div>
      )}
    </div>
  );
}
