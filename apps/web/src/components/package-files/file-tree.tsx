// SPDX-License-Identifier: Apache-2.0

/**
 * WAI-ARIA `tree` over a package artifact's file index. Shape, ARIA bookkeeping and keyboard model
 * are pure functions in `lib/package-file-tree.ts`; this owns state, DOM focus and markup.
 * Rows are virtualized, so `aria-level` / `aria-setsize` / `aria-posinset` are computed by hand.
 * `actions` turns the reader into the authoring surface (rename/delete on unpinned rows, plus
 * whole-tree gestures) without forking the virtualizer and focus logic.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
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
  type TreeNode,
} from "../../lib/package-file-tree";

const ROW_HEIGHT = 26;
const NO_DIRECTORIES: readonly string[] = [];
const NO_COLLAPSED_PATHS: readonly string[] = [];

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
  /** Directories that must remain visible even when they contain no file. */
  directories?: readonly string[];
  /** Directories collapsed on first mount without changing the shared default. */
  initialCollapsedPaths?: readonly string[];
  /** Displayed name of a directory, by path, when its path is a stable key rather than a word. */
  directoryLabels?: Readonly<Record<string, string>>;
  /** Path of the node (file or directory) whose preview is showing, or `null`. */
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** Optional richer selection for explorers that also preview directories. */
  onSelectNode?: (node: TreeNode) => void;
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
  directories = NO_DIRECTORIES,
  initialCollapsedPaths = NO_COLLAPSED_PATHS,
  directoryLabels,
  selectedPath,
  onSelect,
  onSelectNode,
  label,
  controlsId,
  actions,
  showToolbar = true,
  className,
}: FileTreeProps) {
  const { t } = useTranslation("agents");
  const tree = useMemo(() => buildFileTree(entries, directories), [directories, entries]);
  // The user's CLOSED directories, so a directory appearing in a later refetch is open by default.
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(
    () => new Set(initialCollapsedPaths),
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const rows = useMemo(() => flattenVisibleRows(tree, collapsedDirs), [tree, collapsedDirs]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Armed by the key handler, cleared once the focused row is actually mounted.
  const pendingFocusRef = useRef(false);

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Runs after every render on purpose: `scrollToIndex` acts through a scroll event, so a far row
  // is not mounted on the render that changed `focusedId`; the flag survives until it is.
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    const el = scrollRef.current?.querySelector<HTMLElement>('[data-tree-focused="true"]');
    if (!el) return;
    pendingFocusRef.current = false;
    el.focus();
  });

  const setCollapsed = (path: string, collapsed: boolean) => {
    setCollapsedDirs((current) => {
      const next = new Set(current);
      if (collapsed) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const moveFocus = (id: string) => {
    const index = rows.findIndex((row) => row.node.id === id);
    if (index >= 0) virtualizer.scrollToIndex(index);
    // Already focused: React bails out of an identical update, so arming the flag would leave it
    // set until an unrelated re-render yanked focus away from the editor.
    if (id === focusedId) return;
    pendingFocusRef.current = true;
    setFocusedId(id);
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
      onSelectNode?.(row.node);
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
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-1">
        <div
          role="tree"
          aria-label={label}
          aria-controls={controlsId}
          onKeyDown={handleKeyDown}
          style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index]!;
            const node = row.node;
            const isSelected = node.path === selectedPath;
            const isFocused = node.id === focusedId;
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
                data-tree-focused={isFocused ? "true" : undefined}
                onFocus={() => setFocusedId(node.id)}
                onClick={() => {
                  setFocusedId(node.id);
                  if (node.kind === "file") onSelect(node.entry.path);
                  else setCollapsed(node.path, row.expanded);
                  onSelectNode?.(node);
                }}
                className={cn(
                  "hover:bg-muted/60 focus-visible:ring-ring group flex cursor-pointer items-center justify-start gap-1.5 rounded-sm pr-1 text-left text-sm outline-none focus-visible:ring-2",
                  isSelected ? "bg-muted text-foreground font-medium" : "text-muted-foreground",
                )}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: ROW_HEIGHT,
                  // Indent from the row's own start so the whole row stays clickable.
                  paddingLeft: 4 + row.depth * 12,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
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
                <span className="min-w-0 flex-1 truncate">
                  {(node.kind === "dir" && directoryLabels?.[node.path]) || node.name}
                </span>
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
