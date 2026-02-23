import { useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { useImportFlow } from "../hooks/use-mutations";

interface ImportModalProps {
  open: boolean;
  onClose: () => void;
}

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

export function ImportModal({ open, onClose }: ImportModalProps) {
  const { t } = useTranslation(["flows", "common"]);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const importFlow = useImportFlow();

  const validateFile = useCallback(
    (f: File): string => {
      if (!f.name.endsWith(".zip")) return t("import.errZip");
      if (f.size > MAX_SIZE) return t("import.errSize");
      return "";
    },
    [t],
  );

  const handleFile = useCallback(
    (f: File) => {
      const err = validateFile(f);
      if (err) {
        setError(err);
        setFile(null);
      } else {
        setError("");
        setFile(f);
      }
    },
    [validateFile],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    },
    [handleFile],
  );

  const handleSubmit = () => {
    if (!file) return;
    importFlow.mutate(file, {
      onSuccess: () => {
        setFile(null);
        setError("");
        onClose();
      },
    });
  };

  const handleClose = () => {
    if (importFlow.isPending) return;
    setFile(null);
    setError("");
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("import.title")}
      actions={
        <>
          <button onClick={handleClose} disabled={importFlow.isPending}>
            {t("btn.cancel")}
          </button>
          <button
            className="primary"
            onClick={handleSubmit}
            disabled={!file || importFlow.isPending}
          >
            {importFlow.isPending ? t("import.importing") : t("import.submit")}
          </button>
        </>
      }
    >
      <div
        className={`drop-zone ${dragOver ? "drag-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
        {file ? (
          <p className="drop-zone-file">{file.name}</p>
        ) : (
          <>
            <p>{t("import.dropText")}</p>
            <p className="drop-zone-hint">{t("import.dropHint")}</p>
          </>
        )}
      </div>
      {error && <p className="drop-zone-error">{error}</p>}
      {importFlow.isError && <p className="drop-zone-error">{importFlow.error.message}</p>}
    </Modal>
  );
}
