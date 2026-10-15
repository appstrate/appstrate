// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Copy, FileText, Pin, Trash2 } from "lucide-react";
import type { PersistenceActorType } from "@appstrate/shared-types";
import type { DataColumn } from "../data-table";
import { rowActionsColumn } from "../row-actions-column";
import { TableRowActions } from "../table-row-actions";
import { CellDate } from "../table-cells";
import { ActorBadge } from "./actor-badge";
import { memoryText } from "../../lib/memory-items";

/** One entry of the unified memory list: a pinned slot or an archive memory. */
export interface MemoryCollectionItem {
  id: number;
  kind: "pinned" | "archive";
  key: string | null;
  content: unknown;
  actor_type: PersistenceActorType;
  actor_id: string | null;
  runId: string | null;
  updatedAt: string | null;
}

const CHECKPOINT_KEY = "checkpoint";

export function useMemoryColumns({
  isDeleting,
  onCopy,
  onDelete,
}: {
  /** Only the row being deleted shows the spinner. */
  isDeleting: (item: MemoryCollectionItem) => boolean;
  onCopy: (item: MemoryCollectionItem) => void;
  /** Absent without `persistence:delete` (and in a run view): the menu then only copies. */
  onDelete?: (item: MemoryCollectionItem) => void;
}): DataColumn<MemoryCollectionItem>[] {
  const { t } = useTranslation(["agents", "common"]);
  const kindLabel = (item: MemoryCollectionItem) =>
    item.kind === "pinned"
      ? t("agents:detail.memoryTypePinned")
      : t("agents:detail.memoryTypeArchive");

  return [
    {
      id: "type",
      header: t("agents:detail.memoryColumnType"),
      width: 112,
      cell: (item) => (
        <span className="flex items-center gap-2 text-sm">
          {item.kind === "pinned" ? (
            <Pin className="text-primary size-3.5" aria-hidden />
          ) : (
            <FileText className="text-muted-foreground size-3.5" aria-hidden />
          )}
          {kindLabel(item)}
        </span>
      ),
    },
    {
      id: "content",
      header: t("agents:detail.memoryColumnContent"),
      width: 160,
      elastic: true,
      cell: (item) => {
        const content = memoryText(item.content);
        return (
          <span className="min-w-0">
            {item.key && <code className="mr-2 text-xs font-semibold">{item.key}</code>}
            {item.key === CHECKPOINT_KEY && (
              <span className="text-muted-foreground mr-2 text-[10px] tracking-wide uppercase">
                {t("agents:detail.pinnedCheckpointHint")}
              </span>
            )}
            <span
              className="text-muted-foreground relative z-10 block truncate text-sm"
              title={content}
            >
              {content}
            </span>
          </span>
        );
      },
    },
    {
      id: "scope",
      header: t("agents:detail.memoryColumnScope"),
      width: 128,
      tier: 2,
      cell: (item) => <ActorBadge actor_type={item.actor_type} actor_id={item.actor_id} />,
    },
    {
      id: "updated",
      header: t("agents:detail.memoryColumnUpdated"),
      width: 160,
      align: "end",
      tier: 3,
      cell: (item) => <CellDate value={item.updatedAt} />,
    },
    rowActionsColumn((item: MemoryCollectionItem) => (
      <TableRowActions
        menuLabel={t("agents:detail.memoryRowActions")}
        isPending={isDeleting(item)}
        actions={[
          {
            id: "copy",
            label: t("common:btn.copy"),
            icon: Copy,
            onSelect: () => onCopy(item),
          },
          {
            id: "delete",
            label: t("common:btn.delete"),
            icon: Trash2,
            onSelect: () => onDelete?.(item),
            destructive: true,
            hidden: !onDelete,
          },
        ]}
      />
    )),
  ];
}
