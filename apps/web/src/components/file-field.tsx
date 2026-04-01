import { useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
  const { t } = useTranslation(["settings", "common"]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validateAndAdd = useCallback(
    (incoming: File[]) => {
      setError(null);

      if (accept) {
        const allowed = accept
          .split(",")
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean);
        for (const f of incoming) {
          const ext = f.name.includes(".") ? `.${f.name.split(".").pop()!.toLowerCase()}` : "";
          if (!allowed.some((a) => a === ext)) {
            setError(t("file.extError", { name: f.name, accept }));
            return;
          }
        }
      }

      if (maxSize) {
        for (const f of incoming) {
          if (f.size > maxSize) {
            setError(t("file.sizeError", { name: f.name, size: formatSize(maxSize) }));
            return;
          }
        }
      }

      let next: File[];
      if (multiple) {
        next = [...files, ...incoming];
        if (maxFiles && next.length > maxFiles) {
          setError(t("file.maxFiles", { count: maxFiles }));
          return;
        }
      } else {
        next = [incoming[0]!];
      }

      onChange(next);
    },
    [accept, maxSize, multiple, maxFiles, files, onChange, t],
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
    <div className="space-y-2">
      <Label>
        {label}
        {required && " *"}
      </Label>
      {description && <p className="text-muted-foreground text-sm">{description}</p>}
      {files.length === 0 ? (
        <div
          className={cn(
            "text-muted-foreground hover:border-muted-foreground/50 flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center text-sm transition-colors",
            dragOver && "border-primary bg-primary/5",
          )}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {t("file.dragDrop")}
          {accept && <span className="mt-1 text-xs">{t("file.formats", { formats: accept })}</span>}
          {maxSize && (
            <span className="mt-1 text-xs">{t("file.maxSize", { size: formatSize(maxSize) })}</span>
          )}
        </div>
      ) : (
        <>
          <div className="space-y-1">
            {files.map((f, i) => (
              <div
                key={`${f.name}-${i}`}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
              >
                <span className="truncate font-medium">{f.name}</span>
                <span className="text-muted-foreground ml-2 shrink-0">{formatSize(f.size)}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground ml-2 h-7 w-7 shrink-0"
                  onClick={() => removeFile(i)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
          {multiple && (!maxFiles || files.length < maxFiles) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
            >
              {t("file.addFile")}
            </Button>
          )}
        </>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleInputChange}
        className="hidden"
      />
    </div>
  );
}
