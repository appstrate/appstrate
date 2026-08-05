// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only WAI-ARIA `tree` over a package artifact's file index.
 *
 * This component owns the tree's interaction only — its shape, its ARIA
 * bookkeeping and its keyboard model are pure functions in
 * `lib/package-file-tree.ts`, which is where they are tested. What is left here
 * is state, DOM focus and markup.
 *
 * Rows are virtualized, which is why `aria-level` / `aria-setsize` /
 * `aria-posinset` are computed by hand: only a window of rows is in the DOM, so
 * the browser can infer none of them from the markup.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, File as FileIcon, Folder, FolderOpen } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import {
  buildFileTree,
  flattenVisibleRows,
  nextTreeFocus,
  type PackageFileEntry,
} from "../../lib/package-file-tree";

const ROW_HEIGHT = 26;

interface ReadOnlyFileTreeProps {
  entries: readonly PackageFileEntry[];
  /** Path of the file whose preview is showing, or `null`. */
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** Accessible name of the tree (translated by the caller). */
  label: string;
  className?: string;
}

export function ReadOnlyFileTree({
  entries,
  selectedPath,
  onSelect,
  label,
  className,
}: ReadOnlyFileTreeProps) {
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
    <div ref={scrollRef} className={cn("overflow-auto", className)}>
      <div
        role="tree"
        aria-label={label}
        onKeyDown={handleKeyDown}
        style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index]!;
          const node = row.node;
          const isSelected = node.kind === "file" && node.entry.path === selectedPath;
          const isFocused = node.id === focusedId;
          const Icon = node.kind === "file" ? FileIcon : row.expanded ? FolderOpen : Folder;
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
                "hover:bg-muted/60 focus-visible:ring-ring flex cursor-pointer items-center gap-1.5 rounded-sm pr-2 text-sm outline-none focus-visible:ring-2",
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
              <span className="truncate">{node.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
