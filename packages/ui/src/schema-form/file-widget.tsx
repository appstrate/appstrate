// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { X } from "lucide-react";
import type { WidgetProps } from "@rjsf/utils";
import { Button, LABEL_CLASS } from "./templates.tsx";
import { cn } from "./cn.ts";
import { createUploader, isUploadUri, type UploadFn } from "./upload-client.ts";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

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
      const tail = v.slice("upload://".length);
      list.push({ uri: v, name: tail, size: 0 });
    }
  }
  return list;
}

/**
 * Labels consumed by FileWidget. Callers can pass translated strings via
 * `<SchemaForm labels={...}>` so the widget integrates with the host app's
 * i18n system without this package taking a hard dependency on i18next.
 */
export interface FileWidgetLabels {
  uploading?: string;
  dragDrop?: string;
  addFile?: string;
  uploadsDisabled?: string;
  maxSize?: (size: string) => string;
  maxFiles?: (count: number) => string;
  formats?: (formats: string) => string;
  extError?: (name: string, accept: string) => string;
  sizeError?: (name: string, size: string) => string;
}

const DEFAULT_LABELS: Required<FileWidgetLabels> = {
  uploading: "Uploading…",
  dragDrop: "Drag and drop a file here, or click to select",
  addFile: "Add file",
  uploadsDisabled: "File uploads are not configured for this form.",
  maxSize: (size) => `Max ${size}`,
  maxFiles: (count) => `At most ${count} files allowed`,
  formats: (formats) => `Formats: ${formats}`,
  extError: (name, accept) => `${name} is not a supported format (${accept})`,
  sizeError: (name, size) => `${name} exceeds the ${size} size limit`,
};

/**
 * RJSF file widget. Accepts:
 *   - `{ type: "string", format: "uri", contentMediaType }`            → single
 *   - `{ type: "array", items: { type: "string", format: "uri", … } }` → multi
 *
 * The binary is uploaded directly to storage via the endpoint resolved from
 * `formContext.uploadPath` (POST), and `onChange` writes back an
 * `upload://upl_xxx` URI (or array of URIs). RJSF then validates the schema
 * on this URI — the server re-validates when the run is triggered.
 */
export function FileWidget(props: WidgetProps) {
  const { id, value, onChange, required, label, schema, disabled, readonly, options, formContext } =
    props;
  const ctx = (formContext ?? {}) as {
    uploadPath?: string;
    upload?: UploadFn;
    labels?: FileWidgetLabels;
  };
  const labels = useMemo<Required<FileWidgetLabels>>(
    () => ({ ...DEFAULT_LABELS, ...(ctx.labels ?? {}) }),
    [ctx.labels],
  );
  const upload = useMemo<UploadFn | null>(
    () => ctx.upload ?? (ctx.uploadPath ? createUploader(ctx.uploadPath) : null),
    [ctx.upload, ctx.uploadPath],
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>(() => attachmentsFromValue(value));
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const multiple = schema.type === "array" || (options?.multiple as boolean | undefined) === true;
  const accept = (options?.accept as string | undefined) ?? undefined;
  const maxSize = options?.maxSize as number | undefined;
  const maxFiles = options?.maxFiles as number | undefined;

  const commit = useCallback(
    (next: Attachment[]) => {
      setAttachments(next);
      if (multiple) {
        onChange(next.map((a) => a.uri));
      } else {
        onChange(next[0]?.uri);
      }
    },
    [multiple, onChange],
  );

  const addFiles = useCallback(
    async (incoming: File[]) => {
      setError(null);
      if (!upload) {
        setError(labels.uploadsDisabled);
        return;
      }
      for (const f of incoming) {
        if (accept) {
          const allowed = accept
            .split(",")
            .map((e) => e.trim().toLowerCase())
            .filter(Boolean);
          const ext = f.name.includes(".") ? `.${f.name.split(".").pop()!.toLowerCase()}` : "";
          const mimeMatch = allowed.some((a) => {
            if (a.startsWith(".")) return a === ext;
            if (a.endsWith("/*")) return f.type.startsWith(a.slice(0, -1));
            return f.type === a;
          });
          if (!mimeMatch) {
            setError(labels.extError(f.name, accept));
            return;
          }
        }
        if (maxSize && f.size > maxSize) {
          setError(labels.sizeError(f.name, formatSize(maxSize)));
          return;
        }
      }
      const willHave = attachments.length + incoming.length;
      if (multiple && maxFiles && willHave > maxFiles) {
        setError(labels.maxFiles(maxFiles));
        return;
      }

      setUploading(true);
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const uploaded: Attachment[] = [];
        for (const f of incoming) {
          const uri = await upload(f, ctrl.signal);
          uploaded.push({ uri, name: f.name, size: f.size });
        }
        const next = multiple ? [...attachments, ...uploaded] : uploaded.slice(0, 1);
        commit(next);
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(false);
        if (abortRef.current === ctrl) abortRef.current = null;
      }
    },
    [accept, attachments, commit, labels, maxFiles, maxSize, multiple, upload],
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
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
        {required && " *"}
      </label>
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
          {uploading ? labels.uploading : labels.dragDrop}
          {accept && <span className="mt-1 text-xs">{labels.formats(accept)}</span>}
          {maxSize && <span className="mt-1 text-xs">{labels.maxSize(formatSize(maxSize))}</span>}
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
              {uploading ? labels.uploading : labels.addFile}
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
