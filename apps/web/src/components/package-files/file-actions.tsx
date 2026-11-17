// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ChevronDown, Download, Pencil, RefreshCw, TextCursorInput, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { usePackageFileDownload } from "./use-package-file";

/** The gestures a file of the draft offers; each is present only when it applies to that file. */
export interface FileGestures {
  onEdit?: () => void;
  onReplace?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  busy: boolean;
}

/** The one menu of a selected file: edit, replace, rename, download, delete. */
export function FileActionsMenu({
  packageId,
  version,
  downloadPath,
  editHref,
  gestures,
}: {
  packageId: string;
  version?: string;
  /** The file's path in the stored archive: what a download fetches. */
  downloadPath: string;
  /** Where "Modifier" sends a file only the definition can edit. */
  editHref?: string;
  gestures?: FileGestures;
}) {
  const { t } = useTranslation("agents");
  const download = usePackageFileDownload(packageId, version);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          {t("detail.files.actions")}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      {/* Closing must not hand focus back to the trigger: these items open a
          modal whose editor takes the focus, and Monaco loses its keyboard
          input when it is focused on mount and blurred right after. */}
      <DropdownMenuContent align="end" onCloseAutoFocus={(event) => event.preventDefault()}>
        {gestures?.onEdit ? (
          <DropdownMenuItem disabled={gestures.busy} onSelect={gestures.onEdit}>
            <Pencil />
            {t("btn.edit", { ns: "common" })}
          </DropdownMenuItem>
        ) : (
          editHref && (
            <DropdownMenuItem asChild>
              <Link to={editHref}>
                <Pencil />
                {t("btn.edit", { ns: "common" })}
              </Link>
            </DropdownMenuItem>
          )
        )}
        {gestures?.onReplace && (
          <DropdownMenuItem disabled={gestures.busy} onSelect={gestures.onReplace}>
            <RefreshCw />
            {t("files.replace")}
          </DropdownMenuItem>
        )}
        {gestures?.onRename && (
          <DropdownMenuItem disabled={gestures.busy} onSelect={gestures.onRename}>
            <TextCursorInput />
            {t("files.rename")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => void download(downloadPath)}>
          <Download />
          {t("files.downloadFile")}
        </DropdownMenuItem>
        {gestures?.onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={gestures.busy}
              onSelect={gestures.onDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 />
              {t("files.delete")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
