// SPDX-License-Identifier: Apache-2.0

import { useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useForm, useWatch } from "react-hook-form";
import { Modal } from "./modal";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useImportPackage, useImportFromGithub } from "../hooks/use-mutations";
import { toast } from "sonner";
import { ApiError } from "../api";
import i18n from "../i18n";

interface ImportModalProps {
  open: boolean;
  onClose: () => void;
}

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

type FormData = { file: File | null; githubUrl: string };

export function ImportModal({ open, onClose }: ImportModalProps) {
  const { t } = useTranslation(["agents", "common"]);
  const [dragOver, setDragOver] = useState(false);
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
  const importGithub = useImportFromGithub();

  const {
    setValue,
    setError,
    reset,
    control,
    formState: { errors },
  } = useForm<FormData>({
    defaultValues: { file: null, githubUrl: "" },
  });

  const file = useWatch({ control, name: "file" });
  const githubUrl = useWatch({ control, name: "githubUrl" });

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
      setValue("githubUrl", "");
      if (err) {
        setError("root", { message: err });
        setValue("file", null);
      } else {
        setError("root", { message: "" });
        setValue("file", f);
      }
    },
    [validateFile, setValue, setError],
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
    setValue("githubUrl", value);
    setError("root", { message: "" });
    if (value.trim()) {
      setValue("file", null);
      setConfirmOverwrite(null);
      setConfirmIntegrity(null);
    }
  };

  const handleFormSubmit = () => {
    if (hasFile) {
      const force = !!confirmOverwrite || !!confirmIntegrity;
      importPackage.mutate(
        { file: file!, force },
        {
          onSuccess: () => {
            resetAndClose();
          },
          onError: (err) => {
            if (err instanceof ApiError && err.code === "draft_overwrite" && err.details) {
              setConfirmOverwrite({
                packageId: err.details.packageId as string,
                draftVersion: (err.details.draftVersion as string) ?? null,
              });
              return;
            }
            if (err instanceof ApiError && err.code === "integrity_mismatch" && err.details) {
              setConfirmIntegrity({
                packageId: err.details.packageId as string,
                version: err.details.version as string,
              });
              return;
            }
            toast.error(i18n.t("error.prefix", { message: err.message }));
          },
        },
      );
    } else if (hasUrl) {
      importGithub.mutate(githubUrl.trim(), {
        onSuccess: () => {
          resetAndClose();
        },
        onError: (err) => {
          setError("root", { message: err.message });
        },
      });
    }
  };

  const resetAndClose = () => {
    reset({ file: null, githubUrl: "" });
    setConfirmOverwrite(null);
    setConfirmIntegrity(null);
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

  const errorMessage = errors.root?.message;

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
          <Button onClick={handleFormSubmit} disabled={!canSubmit}>
            {submitLabel}
          </Button>
        </>
      }
    >
      {/* --- File upload --- */}
      <div
        className={cn(
          "border-border hover:border-primary/50 cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition-colors",
          dragOver && "border-primary bg-primary/5",
          hasUrl && "pointer-events-none opacity-50",
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
          <p className="text-foreground text-sm font-medium">{file.name}</p>
        ) : (
          <>
            <p className="text-foreground text-sm">{t("import.dropText")}</p>
            <p className="text-muted-foreground mt-1 text-xs">{t("import.dropHint")}</p>
          </>
        )}
      </div>

      {/* --- Separator --- */}
      <div className="relative my-4">
        <div className="absolute inset-0 flex items-center">
          <div className="border-border w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs">
          <span className="bg-popover text-muted-foreground px-2">{t("import.or")}</span>
        </div>
      </div>

      {/* --- URL input --- */}
      <div>
        <label className="text-foreground text-sm font-medium">{t("import.urlLabel")}</label>
        <input
          type="url"
          value={githubUrl}
          onChange={(e) => handleUrlChange(e.target.value)}
          placeholder={t("import.urlPlaceholder")}
          className="border-input bg-background placeholder:text-muted-foreground focus:ring-ring mt-1.5 w-full rounded-md border px-3 py-2 text-sm focus:ring-2 focus:outline-none"
          disabled={isPending}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleFormSubmit();
            }
          }}
        />
      </div>

      {/* --- Errors & confirmations --- */}
      {errorMessage && <p className="text-destructive mt-3 text-sm">{errorMessage}</p>}
      {confirmOverwrite && (
        <p className="text-destructive mt-3 text-sm">
          {t("import.confirmOverwrite", { draftVersion: confirmOverwrite.draftVersion ?? "?" })}
        </p>
      )}
      {confirmIntegrity && (
        <p className="text-destructive mt-3 text-sm">
          {t("import.confirmIntegrity", { version: confirmIntegrity.version })}
        </p>
      )}
    </Modal>
  );
}
