// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { MimeIcon } from "@appstrate/ui/components/mime-icon";
import { RowSpaceName } from "../../components/run-row";
import type { FileDto } from "../../hooks/use-files";
import { formatBytes } from "../../lib/format-bytes";
import { formatDateField } from "../../lib/format-date";
import type { StoredSidebarFile } from "./conversation-sidebar-state";

/**
 * A file on one row of the context panel, wherever it lists files (the Files tab, a run open in the
 * Runs tab): what it is, its size and date, its space when `named`. A click shows it over the
 * Files tab.
 */
export function ConversationFileRow({
  file,
  named,
  onSelect,
}: {
  file: FileDto;
  named: boolean;
  onSelect: (file: StoredSidebarFile) => void;
}) {
  const { t } = useTranslation("chat");
  return (
    <button
      type="button"
      className="hover:bg-muted/50 flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left transition-colors"
      onClick={() => onSelect({ id: file.id, name: file.name, spaceId: file.spaceId })}
    >
      <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-lg">
        <MimeIcon mime={file.mime} name={file.name} className="text-muted-foreground size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{file.name}</span>
        <span className="text-muted-foreground block truncate text-xs">
          {[
            file.purpose === "user_upload"
              ? t("context.files.attachment")
              : t("context.files.output"),
            formatBytes(file.size),
            formatDateField(file.createdAt, "date"),
          ].join(" · ")}
        </span>
      </span>
      {named && <RowSpaceName spaceId={file.spaceId} />}
    </button>
  );
}
