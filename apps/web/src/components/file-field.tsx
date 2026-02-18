import { useRef, useState, useCallback } from "react";

interface FileFieldProps {
  label: string;
  required?: boolean;
  accept?: string;
  maxSize?: number;
  multiple?: boolean;
  maxFiles?: number;
  files: File[];
  onChange: (files: File[]) => void;
  description?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function FileField({
  label,
  required,
  accept,
  maxSize,
  multiple,
  maxFiles,
  files,
  onChange,
  description,
}: FileFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validateAndAdd = useCallback(
    (incoming: File[]) => {
      setError(null);

      // Check extensions
      if (accept) {
        const allowed = accept
          .split(",")
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean);
        for (const f of incoming) {
          const ext = f.name.includes(".") ? `.${f.name.split(".").pop()!.toLowerCase()}` : "";
          if (!allowed.some((a) => a === ext)) {
            setError(`Extension non autorisee pour "${f.name}" (accepte: ${accept})`);
            return;
          }
        }
      }

      // Check size
      if (maxSize) {
        for (const f of incoming) {
          if (f.size > maxSize) {
            setError(`"${f.name}" depasse la taille max (${formatSize(maxSize)})`);
            return;
          }
        }
      }

      let next: File[];
      if (multiple) {
        next = [...files, ...incoming];
        if (maxFiles && next.length > maxFiles) {
          setError(`Maximum ${maxFiles} fichiers`);
          return;
        }
      } else {
        next = [incoming[0]!];
      }

      onChange(next);
    },
    [accept, maxSize, multiple, maxFiles, files, onChange],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const dropped = Array.from(e.dataTransfer.files);
      if (dropped.length > 0) validateAndAdd(dropped);
    },
    [validateAndAdd],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(e.target.files || []);
      if (selected.length > 0) validateAndAdd(selected);
      e.target.value = "";
    },
    [validateAndAdd],
  );

  const removeFile = useCallback(
    (index: number) => {
      onChange(files.filter((_, i) => i !== index));
      setError(null);
    },
    [files, onChange],
  );

  return (
    <div className="form-group">
      <label>
        {label}
        {required && " *"}
      </label>
      {description && <div className="hint">{description}</div>}
      {files.length === 0 ? (
        <div
          className={`drop-zone${dragOver ? " drag-over" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          Glisser-deposer ou cliquer pour selectionner
          {accept && <div className="drop-zone-hint">Formats : {accept}</div>}
          {maxSize && <div className="drop-zone-hint">Max : {formatSize(maxSize)}</div>}
        </div>
      ) : (
        <>
          <div className="file-list">
            {files.map((f, i) => (
              <div key={`${f.name}-${i}`} className="file-item">
                <span className="file-name">{f.name}</span>
                <span className="file-size">{formatSize(f.size)}</span>
                <button type="button" className="file-remove" onClick={() => removeFile(i)}>
                  &times;
                </button>
              </div>
            ))}
          </div>
          {multiple && (!maxFiles || files.length < maxFiles) && (
            <button
              type="button"
              className="add-field-btn"
              onClick={() => inputRef.current?.click()}
            >
              + Ajouter un fichier
            </button>
          )}
        </>
      )}
      {error && <div className="drop-zone-error">{error}</div>}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleInputChange}
        style={{ display: "none" }}
      />
    </div>
  );
}
