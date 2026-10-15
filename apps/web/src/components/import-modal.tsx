// SPDX-License-Identifier: Apache-2.0

import { useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useForm, useWatch } from "react-hook-form";
import { FormModal } from "./form-modal";
import { cn } from "@appstrate/ui/cn";
import { FieldError } from "@appstrate/ui/components/field";
import { Separator } from "@appstrate/ui/components/separator";
import { useImportPackage, useImportFromGithub } from "../hooks/use-mutations";
import { ApiError } from "../api/errors";
import { packageDetailPath } from "../lib/package-paths";
import { errorMessage, onMutationError } from "../lib/mutation-error";

type ImportModalProps = { onClose: () => void } & (
  | {
      /** Leaves the modal for the imported package's page. */
      onLeave: (to: string) => void;
      onImported?: never;
    }
  | {
      /**
       * Stay where you are and hand the result back, instead of opening the
       * imported package. For an import made from inside another form — the
       * integration editor importing its local server — navigating would throw
       * away the form.
       */
      onImported: (result: { packageId: string; type: string }) => void;
      onLeave?: never;
    }
);

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

type FormData = { file: File | null; githubUrl: string };

export function ImportModal({ onClose, onLeave, onImported }: ImportModalProps) {
  const { t } = useTranslation(["agents", "common"]);
  const [dragOver, setDragOver] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState<{
    activeVersion: string | null;
  } | null>(null);
  const [confirmIntegrity, setConfirmIntegrity] = useState<{ version: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const importPackage = useImportPackage({ errorHandledByCaller: true });
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
      const lower = f.name.toLowerCase();
      if (!lower.endsWith(".afps") && !lower.endsWith(".afps-bundle") && !lower.endsWith(".zip")) {
        return t("import.errZip");
      }
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
        { file: file, force },
        {
          onSuccess: finish,
          onError: (err) => {
            if (err instanceof ApiError && err.code === "draft_overwrite") {
              setConfirmOverwrite({
                activeVersion: (err.details?.active_version as string | null) ?? null,
              });
              // The same forced import also replaces a published version: say both.
              if (err.details?.version)
                setConfirmIntegrity({ version: err.details.version as string });
              return;
            }
            if (err instanceof ApiError && err.code === "integrity_mismatch") {
              setConfirmIntegrity({ version: err.details?.version as string });
              return;
            }
            onMutationError(err);
          },
        },
      );
    } else if (hasUrl) {
      importGithub.mutate(githubUrl.trim(), {
        onSuccess: finish,
        onError: (err) => {
          setError("root", { message: errorMessage(err) });
        },
      });
    }
  };

  const resetForm = () => {
    reset({ file: null, githubUrl: "" });
    setConfirmOverwrite(null);
    setConfirmIntegrity(null);
  };

  const resetAndClose = () => {
    resetForm();
    onClose();
  };

  /** A finished import opens the package, or hands it back to the form it was made from. */
  const finish = (result: { packageId: string; type: string }) => {
    resetForm();
    if (onImported) {
      onImported(result);
      onClose();
    } else {
      onLeave(packageDetailPath(result.type, result.packageId));
    }
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

  const rootError = errors.root?.message;

  return (
    <FormModal
      onClose={handleClose}
      onSubmit={(e) => {
        e.preventDefault();
        // The modal may be opened from inside another form (React bubbles through portals).
        e.stopPropagation();
        handleFormSubmit();
      }}
      title={t("import.title")}
      isPending={isPending}
      submitLabel={submitLabel}
      submitDisabled={!canSubmit}
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
          accept=".afps,.afps-bundle,.zip"
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
          <Separator />
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
        />
      </div>

      {/* --- Errors & confirmations --- */}
      <FieldError className="mt-3">{rootError}</FieldError>
      {confirmOverwrite && (
        <FieldError className="mt-3">
          {confirmOverwrite.activeVersion
            ? t("import.confirmOverwrite", { activeVersion: confirmOverwrite.activeVersion })
            : t("import.confirmOverwriteNoVersion")}
        </FieldError>
      )}
      {confirmIntegrity && (
        <FieldError className="mt-3">
          {t("import.confirmIntegrity", { version: confirmIntegrity.version })}
        </FieldError>
      )}
    </FormModal>
  );
}
