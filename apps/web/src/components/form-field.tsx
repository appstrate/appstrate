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
}: FormFieldProps) {
  const hintId = description ? `hint-${id}` : undefined;

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
          aria-describedby={hintId}
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
          aria-describedby={hintId}
        />
      )}
      {description && (
        <div id={hintId} className="hint">
          {description}
        </div>
      )}
    </div>
  );
}
