// SPDX-License-Identifier: Apache-2.0

/**
 * WAI-ARIA `tree` over a package artifact's file index. Shape, ARIA bookkeeping and keyboard model
 * are pure functions in `lib/package-file-tree.ts`; this owns state, DOM focus and markup.
 * An artifact holds tens of files, so every row is rendered. `actions` turns the reader into the
 * authoring surface (rename/delete on unpinned rows, plus whole-tree gestures).
 */

import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderOpen,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import {
  buildFileTree,
  fileActionForKey,
  flattenVisibleRows,
  nextTreeFocus,
  type PackageFileEntry,
} from "../../lib/package-file-tree";

/** What an editable tree can do, supplied by the surface that owns the writes. */
interface FileTreeActions {
  onCreate: () => void;
  onUpload: () => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  /** Entries the write route refuses to rename or delete — see `isPinnedEntry`. */
  isPinned: (path: string) => boolean;
  /** A write is in flight: every gesture is refused until the tree is current again. */
  isBusy: boolean;
}

interface FileTreeProps {
  entries: readonly PackageFileEntry[];
  /** Path of the file whose preview is showing, or `null`. */
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** Accessible name of the tree (translated by the caller). */
  label: string;
  /** `id` of the panel this tree drives — announced as `aria-controls`. */
  controlsId?: string;
  /** Present on the authoring surface only; absent, the tree is read-only. */
  actions?: FileTreeActions;
  /** Off when the surface draws the new-file and import buttons itself. */
  showToolbar?: boolean;
  className?: string;
}

export function FileTree({
  entries,
  selectedPath,
  onSelect,
  label,
  controlsId,
  actions,
  showToolbar = true,
  className,
}: FileTreeProps) {
  const { t } = useTranslation("agents");
  const tree = useMemo(() => buildFileTree(entries), [entries]);
  // The user's CLOSED directories, so a directory appearing in a later refetch is open by default.
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const rows = useMemo(() => flattenVisibleRows(tree, collapsedDirs), [tree, collapsedDirs]);

  const treeRef = useRef<HTMLDivElement>(null);

  const setCollapsed = (path: string, collapsed: boolean) => {
    setCollapsedDirs((current) => {
      const next = new Set(current);
      if (collapsed) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const moveFocus = (id: string) => {
    treeRef.current?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(id)}"]`)?.focus();
  };

  /** The structural gesture a key asks of the focused row, applied or refused. */
  const handleRowAction = (event: React.KeyboardEvent<HTMLDivElement>): boolean => {
    if (!actions || actions.isBusy) return false;
    const action = fileActionForKey(event.key);
    if (!action) return false;
    const row = rows.find((r) => r.node.id === focusedId);
    if (!row || row.node.kind !== "file") return false;
    const path = row.node.entry.path;
    // A pinned row still SWALLOWS the key, so `Delete` never falls to the browser.
    event.preventDefault();
    if (actions.isPinned(path)) return true;
    if (action === "rename") actions.onRename(path);
    else actions.onDelete(path);
    return true;
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    if (event.key === "Enter" || event.key === " ") {
      const row = rows.find((r) => r.node.id === focusedId);
      if (!row) return;
      event.preventDefault();
      // The entry's OWN path, so the preview fetches exactly this file.
      if (row.node.kind === "file") onSelect(row.node.entry.path);
      else setCollapsed(row.node.path, row.expanded);
      return;
    }

    if (handleRowAction(event)) return;

    const action = nextTreeFocus(rows, focusedId, event.key);
    if (!action) return;
    event.preventDefault();
    if (action.type === "focus") {
      moveFocus(action.id);
      return;
    }
    const row = rows.find((r) => r.node.id === action.id);
    if (row) setCollapsed(row.node.path, action.type === "collapse");
  };

  // Exactly one tabbable row: the focused one, else the selected one, else the first.
  const tabbableId =
    rows.find((row) => row.node.id === focusedId)?.node.id ??
    rows.find((row) => row.node.path === selectedPath)?.node.id ??
    rows[0]?.node.id ??
    null;

  return (
    <div className={cn("flex flex-col", className)}>
      {actions && showToolbar && (
        <div className="border-border flex shrink-0 flex-wrap items-center gap-1 border-b p-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={actions.onCreate}
            disabled={actions.isBusy}
          >
            <FilePlus />
            {t("files.newFile")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={actions.onUpload}
            disabled={actions.isBusy}
          >
            <Upload />
            {t("files.upload")}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-1">
        <div
          ref={treeRef}
          role="tree"
          aria-label={label}
          aria-controls={controlsId}
          onKeyDown={handleKeyDown}
        >
          {rows.map((row) => {
            const node = row.node;
            const isSelected = node.path === selectedPath;
            const Icon = node.kind === "file" ? FileIcon : row.expanded ? FolderOpen : Folder;
            const editable =
              actions !== undefined && node.kind === "file" && !actions.isPinned(node.entry.path);
            return (
              <div
                key={node.id}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-setsize={row.setSize}
                aria-posinset={row.posInSet}
                aria-expanded={node.kind === "dir" ? row.expanded : undefined}
                aria-selected={isSelected}
                tabIndex={node.id === tabbableId ? 0 : -1}
                data-tree-id={node.id}
                onFocus={() => setFocusedId(node.id)}
                onClick={() => {
                  setFocusedId(node.id);
                  if (node.kind === "file") onSelect(node.entry.path);
                  else setCollapsed(node.path, row.expanded);
                }}
                className={cn(
                  "hover:bg-muted/60 focus-visible:ring-ring group flex h-[26px] cursor-pointer items-center justify-start gap-1.5 rounded-sm pr-1 text-left text-sm outline-none focus-visible:ring-2",
                  isSelected ? "bg-muted text-foreground font-medium" : "text-muted-foreground",
                )}
                // Indent from the row's own start so the whole row stays clickable.
                style={{ paddingLeft: 4 + row.depth * 12 }}
              >
                {node.kind === "dir" ? (
                  row.expanded ? (
                    <ChevronDown size={12} className="shrink-0" aria-hidden />
                  ) : (
                    <ChevronRight size={12} className="shrink-0" aria-hidden />
                  )
                ) : (
                  <span className="w-3 shrink-0" aria-hidden />
                )}
                <Icon size={13} className="shrink-0 opacity-70" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
                {editable && node.kind === "file" && (
                  // `tabIndex={-1}`: the roving tabindex is the treeitem's one tab stop; the keyboard
                  // path is F2/Delete (`fileActionForKey`), these buttons are the pointer path.
                  <span className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                    <RowAction
                      icon={Pencil}
                      label={t("files.rename")}
                      disabled={actions.isBusy}
                      onClick={() => actions.onRename(node.entry.path)}
                    />
                    <RowAction
                      icon={Trash2}
                      label={t("files.delete")}
                      disabled={actions.isBusy}
                      onClick={() => actions.onDelete(node.entry.path)}
                    />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RowAction({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: typeof Pencil;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      title={label}
      disabled={disabled}
      className="hover:bg-background text-muted-foreground hover:text-foreground rounded-sm p-1 disabled:opacity-40"
      onClick={(event) => {
        // The row selects on click; this must not open the file underneath.
        event.stopPropagation();
        onClick();
      }}
    >
      <Icon size={12} />
    </button>
  );
}
