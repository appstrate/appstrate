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
import { FormItem } from "@appstrate/ui/components/field";
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
      <FormItem
        id={inputId}
        label={t("files.pathLabel")}
        error={rejection ? t(NEW_PATH_ERROR_KEYS[rejection]) : undefined}
      >
        <Input
          value={path}
          autoFocus
          // A rename opens on the current path: typing replaces it.
          onFocus={(e) => e.currentTarget.select()}
          spellCheck={false}
          placeholder={t("files.pathPlaceholder")}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            submit();
          }}
        />
      </FormItem>
    </Modal>
  );
}
