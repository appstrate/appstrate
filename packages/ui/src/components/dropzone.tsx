// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useRef, useState } from "react";
import { Upload, X, File as FileIcon, AlertCircle } from "lucide-react";
import { cn } from "./lib/utils.ts";

/** Handed to `upload` so it can report progress and honor cancellation. */
export interface DropzoneUploadController {
  /** Report upload progress as a fraction 0..1. */
  onProgress: (fraction: number) => void;
  /** Aborted when the user cancels the item — pass to fetch/XHR. */
  signal: AbortSignal;
}

/**
 * User-facing copy. This is a locale-agnostic design-system primitive: the host
 * app injects translated strings via `labels` (see `useSchemaFormLabels` for the
 * sibling pattern). English defaults below are the neutral fallback, never shown
 * to end users once a consumer wires its i18n.
 */
export interface DropzoneLabels {
  /** Main call-to-action shown inside the drop area. */
  cta?: string;
  /** Fallback message when an upload rejects without an `Error` message. */
  uploadFailed?: string;
  /** `aria-label` for the cancel button while a file is uploading. */
  cancel?: string;
  /** `aria-label` for the dismiss button on a file that failed. */
  remove?: string;
}

const DEFAULT_LABELS: Required<DropzoneLabels> = {
  cta: "Drag and drop a file here, or click to select",
  uploadFailed: "Upload failed",
  cancel: "Cancel",
  remove: "Remove",
};

export interface DropzoneProps {
  /**
   * Upload one file. Report progress via `ctrl.onProgress` and abort when
   * `ctrl.signal` fires. Resolve on success, reject on failure.
   */
  upload: (file: File, ctrl: DropzoneUploadController) => Promise<void>;
  /** Called after each file uploads successfully (e.g. to refresh a list). */
  onUploaded?: (file: File) => void;
  /** `accept` attribute for the file input (e.g. "image/*,.pdf"). */
  accept?: string;
  /** Allow selecting/dropping several files at once (default true). */
  multiple?: boolean;
  disabled?: boolean;
  /** Secondary hint under the call-to-action (caller-provided, already localized). */
  hint?: string;
  /** Localized copy injected by the host app. Falls back to English. */
  labels?: DropzoneLabels;
  className?: string;
}

interface UploadItem {
  id: string;
  name: string;
  progress: number;
  error?: string;
  controller: AbortController;
}

/**
 * Drag-and-drop upload zone with per-file progress and cancellation. Shared
 * across modules (storage, chat attachments, workspace…): pass an `upload`
 * function that streams the bytes and reports progress; the component owns the
 * drag-drop UX, the progress bars and the cancel controls.
 */
export function Dropzone({
  upload,
  onUploaded,
  accept,
  multiple = true,
  disabled = false,
  hint,
  labels,
  className,
}: DropzoneProps) {
  const l = useMemo<Required<DropzoneLabels>>(() => ({ ...DEFAULT_LABELS, ...labels }), [labels]);
  const [dragOver, setDragOver] = useState(false);
  const [items, setItems] = useState<UploadItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const patch = useCallback((id: string, fields: Partial<UploadItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...fields } : it)));
  }, []);
  const drop = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const start = useCallback(
    (file: File) => {
      const id = crypto.randomUUID();
      const controller = new AbortController();
      setItems((prev) => [...prev, { id, name: file.name, progress: 0, controller }]);
      upload(file, {
        signal: controller.signal,
        onProgress: (f) => patch(id, { progress: Math.max(0, Math.min(1, f)) }),
      })
        .then(() => {
          drop(id);
          onUploaded?.(file);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) {
            drop(id);
            return;
          }
          patch(id, { error: err instanceof Error ? err.message : l.uploadFailed });
        });
    },
    [upload, onUploaded, patch, drop, l.uploadFailed],
  );

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || disabled) return;
      const list = multiple ? Array.from(files) : files[0] ? [files[0]] : [];
      for (const f of list) start(f);
    },
    [disabled, multiple, start],
  );

  return (
    <div className={cn("space-y-2", className)}>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        className={cn(
          "border-border hover:border-primary/50 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors",
          dragOver && "border-primary bg-primary/5",
          disabled && "pointer-events-none opacity-50",
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
      >
        <Upload className="text-muted-foreground size-6" aria-hidden />
        <p className="text-foreground text-sm font-medium">{l.cta}</p>
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {items.length > 0 && (
        <ul className="space-y-1">
          {items.map((it) => (
            <li
              key={it.id}
              className="bg-muted/50 flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
            >
              {it.error ? (
                <AlertCircle className="text-destructive size-4 shrink-0" aria-hidden />
              ) : (
                <FileIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate">{it.name}</p>
                {it.error ? (
                  <p className="text-destructive text-xs">{it.error}</p>
                ) : (
                  <div className="bg-border mt-1 h-1 overflow-hidden rounded-full">
                    <div
                      className="bg-primary h-full transition-[width] duration-150"
                      style={{ width: `${Math.round(it.progress * 100)}%` }}
                    />
                  </div>
                )}
              </div>
              <button
                type="button"
                aria-label={it.error ? l.remove : l.cancel}
                onClick={() => {
                  it.controller.abort();
                  drop(it.id);
                }}
                className="text-muted-foreground hover:text-foreground shrink-0"
              >
                <X className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
