// SPDX-License-Identifier: Apache-2.0

/**
 * "Where does this file go?" — the one dialog behind both *Nouveau fichier* and
 * *Renommer*, because both ask the same question and refuse the same answers.
 *
 * Mounted only while it is open, as `UnsavedChangesModal` is: the field's
 * starting value is a prop, and a dialog that outlived its opening would come
 * back holding the path of whatever was renamed last.
 *
 * Validation is live and local (`validateNewPath`), so a path the write route
 * would refuse is refused while the field still has focus. The server re-runs
 * the same rules under its lock and stays the authority: this index is a
 * snapshot, and a path free when it was read can be taken by the time the
 * request lands.
 */

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../modal";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import {
  validateNewPath,
  NEW_PATH_ERROR_KEYS,
  type PackageFileEntry,
} from "../../lib/package-file-tree";

interface FilePathDialogProps {
  title: string;
  confirmLabel: string;
  /** Pre-filled value — the current path when renaming, empty when creating. */
  initialPath: string;
  /** The tree the path must fit into, minus the entry being renamed. */
  entries: readonly PackageFileEntry[];
  onClose: () => void;
  onSubmit: (path: string) => void;
}

export function FilePathDialog({
  title,
  confirmLabel,
  initialPath,
  entries,
  onClose,
  onSubmit,
}: FilePathDialogProps) {
  const { t } = useTranslation(["agents", "common"]);
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const [path, setPath] = useState(initialPath);

  const rejection = path === "" ? null : validateNewPath(entries, path);
  const canSubmit = path !== "" && rejection === null && path !== initialPath;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit(path);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      actions={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("btn.cancel", { ns: "common" })}
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <label htmlFor={inputId} className="text-sm font-medium">
          {t("files.pathLabel")}
        </label>
        <Input
          id={inputId}
          value={path}
          autoFocus
          spellCheck={false}
          placeholder={t("files.pathPlaceholder")}
          aria-invalid={rejection !== null}
          aria-describedby={rejection ? errorId : undefined}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            submit();
          }}
        />
        {rejection && (
          <p id={errorId} role="alert" className="text-destructive text-sm">
            {t(NEW_PATH_ERROR_KEYS[rejection])}
          </p>
        )}
      </div>
    </Modal>
  );
}
