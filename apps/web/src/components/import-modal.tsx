// SPDX-License-Identifier: Apache-2.0

import { useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { FormModal } from "./form-modal";
import { cn } from "@appstrate/ui/cn";
import { Field, FieldError, FieldLabel, FieldSeparator } from "@appstrate/ui/components/field";
import { Input } from "@appstrate/ui/components/input";
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

function fileRefusal(f: File): "import.errZip" | "import.errSize" | null {
  const lower = f.name.toLowerCase();
  if (!lower.endsWith(".afps") && !lower.endsWith(".afps-bundle") && !lower.endsWith(".zip")) {
    return "import.errZip";
  }
  return f.size > MAX_SIZE ? "import.errSize" : null;
}

export function ImportModal({ onClose, onLeave, onImported }: ImportModalProps) {
  const { t } = useTranslation(["agents", "common"]);
  const [file, setFile] = useState<File | null>(null);
  const [githubUrl, setGithubUrl] = useState("");
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState<{
    activeVersion: string | null;
  } | null>(null);
  const [confirmIntegrity, setConfirmIntegrity] = useState<{ version: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const importPackage = useImportPackage({ errorHandledByCaller: true });
  const importGithub = useImportFromGithub();

  const isPending = importPackage.isPending || importGithub.isPending;
  const hasUrl = !!githubUrl.trim();

  const clearConfirmations = () => {
    setConfirmOverwrite(null);
    setConfirmIntegrity(null);
  };

  const handleFile = (f: File) => {
    const refusal = fileRefusal(f);
    clearConfirmations();
    setGithubUrl("");
    setError(refusal ? t(refusal) : "");
    setFile(refusal ? null : f);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  const handleUrlChange = (value: string) => {
    setGithubUrl(value);
    setError("");
    if (value.trim()) {
      setFile(null);
      clearConfirmations();
    }
  };

  /** A finished import opens the package, or hands it back to the form it was made from. */
  const finish = (result: { packageId: string; type: string }) => {
    if (onImported) {
      onImported(result);
      onClose();
    } else {
      onLeave(packageDetailPath(result.type, result.packageId));
    }
  };

  const handleFormSubmit = () => {
    if (file) {
      const force = !!confirmOverwrite || !!confirmIntegrity;
      importPackage.mutate(
        { file, force },
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
        onError: (err) => setError(errorMessage(err)),
      });
    }
  };

  const submitLabel = isPending
    ? t("import.importing")
    : confirmOverwrite
      ? t("import.forceSubmit")
      : confirmIntegrity
        ? t("import.forceIntegrity")
        : t("common:nav.import");

  return (
    <FormModal
      onClose={onClose}
      onSubmit={(e) => {
        e.preventDefault();
        // The modal may be opened from inside another form (React bubbles through portals).
        e.stopPropagation();
        handleFormSubmit();
      }}
      title={t("import.title")}
      isPending={isPending}
      submitLabel={submitLabel}
      submitDisabled={!file && !hasUrl}
      error={error}
    >
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

      <FieldSeparator>{t("import.or")}</FieldSeparator>

      <Field>
        <FieldLabel htmlFor="import-url">{t("import.urlLabel")}</FieldLabel>
        <Input
          id="import-url"
          type="url"
          value={githubUrl}
          onChange={(e) => handleUrlChange(e.target.value)}
          placeholder={t("import.urlPlaceholder")}
          disabled={isPending}
        />
      </Field>

      {confirmOverwrite && (
        <FieldError>
          {confirmOverwrite.activeVersion
            ? t("import.confirmOverwrite", { activeVersion: confirmOverwrite.activeVersion })
            : t("import.confirmOverwriteNoVersion")}
        </FieldError>
      )}
      {confirmIntegrity && (
        <FieldError>
          {t("import.confirmIntegrity", { version: confirmIntegrity.version })}
        </FieldError>
      )}
    </FormModal>
  );
}
