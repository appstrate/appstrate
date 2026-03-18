import { useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useImportPackage, useImportFromGithub } from "../hooks/use-mutations";
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
  const [githubUrl, setGithubUrl] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const importPackage = useImportPackage();
  const importGithub = useImportFromGithub();

  const isPending = importPackage.isPending || importGithub.isPending;
  const hasFile = !!file;
  const hasUrl = !!githubUrl.trim();
  const canSubmit = (hasFile || hasUrl) && !isPending;

  const validateFile = useCallback(
    (f: File): string => {
      if (!f.name.endsWith(".afps") && !f.name.endsWith(".zip")) return t("import.errZip");
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
      setGithubUrl("");
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

  const handleUrlChange = (value: string) => {
    setGithubUrl(value);
    setError("");
    if (value.trim()) {
      setFile(null);
      setConfirmOverwrite(null);
      setConfirmIntegrity(null);
    }
  };

  const handleSubmit = () => {
    if (hasFile) {
      const force = !!confirmOverwrite || !!confirmIntegrity;
      importPackage.mutate(
        { file: file!, force },
        {
          onSuccess: () => {
            resetAndClose();
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
    } else if (hasUrl) {
      importGithub.mutate(githubUrl.trim(), {
        onSuccess: () => {
          resetAndClose();
        },
        onError: (err) => {
          setError(err.message);
        },
      });
    }
  };

  const resetAndClose = () => {
    setFile(null);
    setError("");
    setConfirmOverwrite(null);
    setConfirmIntegrity(null);
    setGithubUrl("");
    onClose();
  };

  const handleClose = () => {
    if (isPending) return;
    resetAndClose();
  };

  const submitLabel = isPending
    ? t("import.importing")
    : confirmOverwrite
      ? t("import.forceSubmit")
      : confirmIntegrity
        ? t("import.forceIntegrity")
        : t("import.submit");

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("import.title")}
      actions={
        <>
          <Button variant="outline" onClick={handleClose} disabled={isPending}>
            {t("btn.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitLabel}
          </Button>
        </>
      }
    >
      {/* --- File upload --- */}
      <div
        className={cn(
          "rounded-lg border-2 border-dashed border-border p-8 text-center cursor-pointer transition-colors hover:border-primary/50",
          dragOver && "border-primary bg-primary/5",
          hasUrl && "opacity-50 pointer-events-none",
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
          accept=".afps,.zip"
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

      {/* --- Separator --- */}
      <div className="relative my-4">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center text-xs">
          <span className="bg-popover px-2 text-muted-foreground">{t("import.or")}</span>
        </div>
      </div>

      {/* --- URL input --- */}
      <div>
        <label className="text-sm font-medium text-foreground">{t("import.urlLabel")}</label>
        <input
          type="url"
          value={githubUrl}
          onChange={(e) => handleUrlChange(e.target.value)}
          placeholder={t("import.urlPlaceholder")}
          className="mt-1.5 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          disabled={isPending}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />
      </div>

      {/* --- Errors & confirmations --- */}
      {error && <p className="text-sm text-destructive mt-3">{error}</p>}
      {confirmOverwrite && (
        <p className="text-sm text-destructive mt-3">
          {t("import.confirmOverwrite", { draftVersion: confirmOverwrite.draftVersion ?? "?" })}
        </p>
      )}
      {confirmIntegrity && (
        <p className="text-sm text-destructive mt-3">
          {t("import.confirmIntegrity", { version: confirmIntegrity.version })}
        </p>
      )}
    </Modal>
  );
}
