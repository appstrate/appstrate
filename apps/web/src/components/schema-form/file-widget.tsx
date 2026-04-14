// SPDX-License-Identifier: Apache-2.0

import { useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { WidgetProps } from "@rjsf/utils";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { uploadFile, isUploadUri } from "./upload-client";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Client-side metadata for a staged file — we keep the original File object so
 *  the user can see its name/size without re-fetching the upload record. */
interface Attachment {
  uri: string;
  name: string;
  size: number;
}

function attachmentsFromValue(value: unknown): Attachment[] {
  const list: Attachment[] = [];
  const raw = Array.isArray(value) ? value : value != null ? [value] : [];
  for (const v of raw) {
    if (isUploadUri(v)) {
      // We don't have name/size once persisted — fall back to the URI suffix.
      const tail = v.slice("upload://".length);
      list.push({ uri: v, name: tail, size: 0 });
    }
  }
  return list;
}

/**
 * RJSF file widget. Accepts:
 *   - `{ type: "string", format: "uri", contentMediaType }`            → single
 *   - `{ type: "array", items: { type: "string", format: "uri", … } }` → multi
 *
 * The binary is uploaded directly to storage via `POST /api/uploads`, and
 * `onChange` writes back an `upload://upl_xxx` URI (or array of URIs).
 * RJSF then validates the schema on this URI — the server re-validates
 * when the run is triggered.
 */
export function FileWidget(props: WidgetProps) {
  const { id, value, onChange, required, label, schema, disabled, readonly, options } = props;
  const { t } = useTranslation(["settings", "common"]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>(() => attachmentsFromValue(value));

  const multiple = schema.type === "array" || (options?.multiple as boolean | undefined) === true;
  const accept = (options?.accept as string | undefined) ?? undefined;
  const maxSize = options?.maxSize as number | undefined;
  const maxFiles = options?.maxFiles as number | undefined;

  const validateClientSide = (file: File): string | null => {
    if (accept) {
      const allowed = accept
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
      const ext = file.name.includes(".") ? `.${file.name.split(".").pop()!.toLowerCase()}` : "";
      const mimeMatch = allowed.some((a) => {
        if (a.startsWith(".")) return a === ext;
        if (a.endsWith("/*")) return file.type.startsWith(a.slice(0, -1));
        return file.type === a;
      });
      if (!mimeMatch) return t("file.extError", { name: file.name, accept });
    }
    if (maxSize && file.size > maxSize) {
      return t("file.sizeError", { name: file.name, size: formatSize(maxSize) });
    }
    return null;
  };

  const commit = (next: Attachment[]) => {
    setAttachments(next);
    if (multiple) {
      onChange(next.map((a) => a.uri));
    } else {
      onChange(next[0]?.uri);
    }
  };

  const addFiles = useCallback(
    async (incoming: File[]) => {
      setError(null);
      for (const f of incoming) {
        const err = validateClientSide(f);
        if (err) {
          setError(err);
          return;
        }
      }
      const willHave = attachments.length + incoming.length;
      if (multiple && maxFiles && willHave > maxFiles) {
        setError(t("file.maxFiles", { count: maxFiles }));
        return;
      }

      setUploading(true);
      try {
        const uploaded: Attachment[] = [];
        for (const f of incoming) {
          const uri = await uploadFile(f);
          uploaded.push({ uri, name: f.name, size: f.size });
        }
        const next = multiple ? [...attachments, ...uploaded] : uploaded.slice(0, 1);
        commit(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(false);
      }
    },
    // commit is stable inside this closure; disabling deps to avoid over-reacting
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accept, attachments, maxFiles, maxSize, multiple, t],
  );

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length > 0) void addFiles(dropped);
  };

  const handleSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    if (selected.length > 0) void addFiles(selected);
    e.target.value = "";
  };

  const remove = (idx: number) => {
    commit(attachments.filter((_, i) => i !== idx));
    setError(null);
  };

  const locked = disabled || readonly || uploading;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}
        {required && " *"}
      </Label>
      {attachments.length === 0 ? (
        <div
          className={cn(
            "text-muted-foreground hover:border-muted-foreground/50 flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center text-sm transition-colors",
            dragOver && "border-primary bg-primary/5",
            locked && "pointer-events-none opacity-60",
          )}
          onClick={() => !locked && inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            if (!locked) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => !locked && handleDrop(e)}
        >
          {uploading ? t("file.uploading", { defaultValue: "Uploading…" }) : t("file.dragDrop")}
          {accept && <span className="mt-1 text-xs">{t("file.formats", { formats: accept })}</span>}
          {maxSize && (
            <span className="mt-1 text-xs">{t("file.maxSize", { size: formatSize(maxSize) })}</span>
          )}
        </div>
      ) : (
        <>
          <div className="space-y-1">
            {attachments.map((a, i) => (
              <div
                key={`${a.uri}-${i}`}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
              >
                <span className="truncate font-medium">{a.name}</span>
                {a.size > 0 && (
                  <span className="text-muted-foreground ml-2 shrink-0">{formatSize(a.size)}</span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground ml-2 h-7 w-7 shrink-0"
                  disabled={locked}
                  onClick={() => remove(i)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
          {multiple && (!maxFiles || attachments.length < maxFiles) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={locked}
              onClick={() => inputRef.current?.click()}
            >
              {uploading ? t("file.uploading", { defaultValue: "Uploading…" }) : t("file.addFile")}
            </Button>
          )}
        </>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={locked}
        onChange={handleSelect}
        className="hidden"
      />
    </div>
  );
}
