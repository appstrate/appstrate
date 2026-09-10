// SPDX-License-Identifier: Apache-2.0

/**
 * WAI-ARIA `tree` over a package artifact's file index.
 *
 * This component owns the tree's interaction only — its shape, its ARIA
 * bookkeeping and its keyboard model are pure functions in
 * `lib/package-file-tree.ts`, which is where they are tested. What is left here
 * is state, DOM focus and markup.
 *
 * Rows are virtualized, which is why `aria-level` / `aria-setsize` /
 * `aria-posinset` are computed by hand: only a window of rows is in the DOM, so
 * the browser can infer none of them from the markup.
 *
 * `actions` is what separates the two surfaces that mount it. Without it the
 * tree is a reader (the package detail page's explorer); with it every row that
 * is not pinned carries a rename and a delete, and the header carries the two
 * whole-tree gestures. One component, because the difference is four buttons —
 * a fork would duplicate the virtualizer, the roving tabindex and the focus
 * effect for them.
 */

import { useEffect, useMemo, useRef, useState } from "react";
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
  TriangleAlert,
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

const ROW_HEIGHT = 26;

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
  /**
   * Paths whose server bytes moved while the author's text sat unsent. Marked in
   * the row so the file is findable without opening every tab of the tree — the
   * pane says what it means, this says WHERE.
   */
  conflicted: ReadonlySet<string>;
  labels: {
    newFile: string;
    upload: string;
    rename: string;
    delete: string;
    conflicted: string;
  };
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
  className?: string;
}

export function FileTree({
  entries,
  selectedPath,
  onSelect,
  label,
  controlsId,
  actions,
  className,
}: FileTreeProps) {
  const tree = useMemo(() => buildFileTree(entries), [entries]);
  // The user's CLOSED directories, not their open ones. Package archives are
  // small (tens of files), so the whole artifact is visible at a glance by
  // default — and a directory that appears in a later refetch is open by
  // construction rather than the one closed row in an otherwise open tree.
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(() => new Set());
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

  // Move real DOM focus onto the row the keyboard model picked. Runs after every
  // render on purpose: `scrollToIndex` reaches the virtualizer through a scroll
  // event, so a row scrolled in from far away is not mounted yet on the render
  // that changed `focusedId` — the flag survives until it is. `moveFocus` only
  // ever arms the flag alongside a state change that guarantees this runs.
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
    // Already focused: React bails out of an identical state update, so no
    // render and no effect would follow. Arming the flag here would leave it
    // armed until some unrelated re-render, which would then yank focus out of
    // whatever the user had moved on to (the editor, most likely). Reachable
    // via Home on the first row, End on the last, and a type-ahead that wraps.
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
    // A pinned row still SWALLOWS the key: letting `Delete` bubble on a row the
    // route would refuse invites the browser's own handling of it.
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
      // Selection carries the entry's OWN path, so a reconstructed path can
      // never disagree with the file the preview then fetches.
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

  // Exactly one row is tabbable — ids are unique, so this cannot match twice:
  // the focused row, else the selected one, else the first, so Tab always lands
  // somewhere sensible inside the tree.
  const tabbableId =
    rows.find((row) => row.node.id === focusedId)?.node.id ??
    rows.find((row) => row.node.kind === "file" && row.node.entry.path === selectedPath)?.node.id ??
    rows[0]?.node.id ??
    null;

  return (
    <div className={cn("flex flex-col", className)}>
      {actions && (
        <div className="border-border flex shrink-0 items-center gap-1 border-b p-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={actions.onCreate}
            disabled={actions.isBusy}
          >
            <FilePlus size={13} />
            {actions.labels.newFile}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={actions.onUpload}
            disabled={actions.isBusy}
          >
            <Upload size={13} />
            {actions.labels.upload}
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
            const isSelected = node.kind === "file" && node.entry.path === selectedPath;
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
                aria-selected={node.kind === "file" ? isSelected : undefined}
                tabIndex={node.id === tabbableId ? 0 : -1}
                data-tree-focused={isFocused ? "true" : undefined}
                onFocus={() => setFocusedId(node.id)}
                onClick={() => {
                  setFocusedId(node.id);
                  if (node.kind === "file") onSelect(node.entry.path);
                  else setCollapsed(node.path, row.expanded);
                }}
                className={cn(
                  "hover:bg-muted/60 focus-visible:ring-ring group flex cursor-pointer items-center gap-1.5 rounded-sm pr-1 text-sm outline-none focus-visible:ring-2",
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
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
                {node.kind === "file" && actions?.conflicted.has(node.entry.path) && (
                  <TriangleAlert
                    size={12}
                    // Named, not decorative: this is the only thing in the row
                    // that says the file is contested, and a screen reader
                    // reaching the row must hear it. What it MEANS is the
                    // banner's job, in the pane that opens on click.
                    role="img"
                    aria-label={actions.labels.conflicted}
                    className="shrink-0 text-amber-600"
                  />
                )}
                {editable && node.kind === "file" && (
                  // `tabIndex={-1}`: a `treeitem` owns exactly one tab stop, and
                  // the roving tabindex above IS that stop. The keyboard path to
                  // these two gestures is F2 and Delete on the focused row, which
                  // is why `fileActionForKey` exists; the buttons are the pointer
                  // path, and stay named for a screen reader that reaches them
                  // through the row.
                  <span className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                    <RowAction
                      icon={Pencil}
                      label={actions.labels.rename}
                      disabled={actions.isBusy}
                      onClick={() => actions.onRename(node.entry.path)}
                    />
                    <RowAction
                      icon={Trash2}
                      label={actions.labels.delete}
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
        // The row selects on click; a gesture aimed at the button is not a
        // request to open the file underneath it.
        event.stopPropagation();
        onClick();
      }}
    >
      <Icon size={12} />
    </button>
  );
}
