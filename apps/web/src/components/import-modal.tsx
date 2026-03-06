import { useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useImportPackage } from "../hooks/use-mutations";
import { ApiError } from "../api";
import i18n from "../i18n";

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
  const [confirmOverwrite, setConfirmOverwrite] = useState<{
    packageId: string;
    draftVersion: string | null;
  } | null>(null);
  const [confirmIntegrity, setConfirmIntegrity] = useState<{
    packageId: string;
    version: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const importPackage = useImportPackage();

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
      setConfirmOverwrite(null);
      setConfirmIntegrity(null);
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
    const force = !!confirmOverwrite || !!confirmIntegrity;
    importPackage.mutate(
      { file, force },
      {
        onSuccess: () => {
          setFile(null);
          setError("");
          setConfirmOverwrite(null);
          setConfirmIntegrity(null);
          onClose();
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === "DRAFT_OVERWRITE" && err.details) {
            setConfirmOverwrite({
              packageId: err.details.packageId as string,
              draftVersion: (err.details.draftVersion as string) ?? null,
            });
            return;
          }
          if (err instanceof ApiError && err.code === "INTEGRITY_MISMATCH" && err.details) {
            setConfirmIntegrity({
              packageId: err.details.packageId as string,
              version: err.details.version as string,
            });
            return;
          }
          alert(i18n.t("error.prefix", { message: err.message }));
        },
      },
    );
  };

  const handleClose = () => {
    if (importPackage.isPending) return;
    setFile(null);
    setError("");
    setConfirmOverwrite(null);
    setConfirmIntegrity(null);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("import.title")}
      actions={
        <>
          <Button variant="outline" onClick={handleClose} disabled={importPackage.isPending}>
            {t("btn.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={!file || importPackage.isPending}>
            {importPackage.isPending
              ? t("import.importing")
              : confirmOverwrite
                ? t("import.forceSubmit")
                : confirmIntegrity
                  ? t("import.forceIntegrity")
                  : t("import.submit")}
          </Button>
        </>
      }
    >
      <div
        className={cn(
          "rounded-lg border-2 border-dashed border-border p-8 text-center cursor-pointer transition-colors hover:border-primary/50",
          dragOver && "border-primary bg-primary/5",
        )}
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
          <p className="text-sm font-medium text-foreground">{file.name}</p>
        ) : (
          <>
            <p className="text-sm text-foreground">{t("import.dropText")}</p>
            <p className="text-xs text-muted-foreground mt-1">{t("import.dropHint")}</p>
          </>
        )}
      </div>
      {error && <p className="text-sm text-destructive mt-2">{error}</p>}
      {confirmOverwrite && (
        <p className="text-sm text-destructive mt-2">
          {t("import.confirmOverwrite", { draftVersion: confirmOverwrite.draftVersion ?? "?" })}
        </p>
      )}
      {confirmIntegrity && (
        <p className="text-sm text-destructive mt-2">
          {t("import.confirmIntegrity", { version: confirmIntegrity.version })}
        </p>
      )}
      {importPackage.isError && !confirmOverwrite && !confirmIntegrity && (
        <p className="text-sm text-destructive mt-2">{importPackage.error.message}</p>
      )}
    </Modal>
  );
}
