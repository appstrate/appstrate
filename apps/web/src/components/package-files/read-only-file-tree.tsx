// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only WAI-ARIA `tree` over a package artifact's file index.
 *
 * This file is the explorer's single replaceable seam: every tree behaviour
 * (expansion, roving focus, ARIA bookkeeping) lives either here or in
 * `lib/package-file-tree.ts`, so swapping in a headless tree library later
 * touches one component and no consumer.
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
  collectDirPaths,
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
  // Package archives are small (tens of files), so an all-open tree shows the
  // whole artifact at a glance instead of making the user drill into every
  // directory to find out it holds one file.
  const [expandedDirs, setExpandedDirs] = useState(() => collectDirPaths(tree));
  const [focusedPath, setFocusedPath] = useState<string | null>(null);

  const rows = useMemo(() => flattenVisibleRows(tree, expandedDirs), [tree, expandedDirs]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Set by the key handler, cleared once the focused row is actually mounted.
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
  // that changed `focusedPath` — the flag survives until it is.
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    const el = scrollRef.current?.querySelector<HTMLElement>('[data-tree-focused="true"]');
    if (!el) return;
    pendingFocusRef.current = false;
    el.focus();
  });

  const toggleDir = (path: string, expand: boolean) => {
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (expand) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const moveFocus = (path: string) => {
    setFocusedPath(path);
    pendingFocusRef.current = true;
    const index = rows.findIndex((row) => row.path === path);
    if (index >= 0) virtualizer.scrollToIndex(index);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    if (event.key === "Enter" || event.key === " ") {
      const row = rows.find((r) => r.path === focusedPath);
      if (!row) return;
      event.preventDefault();
      if (row.kind === "dir") toggleDir(row.path, !row.expanded);
      else onSelect(row.path);
      return;
    }

    const action = nextTreeFocus(rows, focusedPath, event.key);
    if (!action) return;
    event.preventDefault();
    if (action.type === "focus") moveFocus(action.path);
    else toggleDir(action.path, action.type === "expand");
  };

  // Exactly one row is tabbable: the focused one, else the selected one, else
  // the first — so Tab always lands somewhere sensible inside the tree.
  const tabbablePath = rows.some((row) => row.path === focusedPath)
    ? focusedPath
    : rows.some((row) => row.path === selectedPath)
      ? selectedPath
      : (rows[0]?.path ?? null);

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
          const isSelected = row.kind === "file" && row.path === selectedPath;
          const isFocused = row.path === focusedPath;
          const Icon = row.kind === "file" ? FileIcon : row.expanded ? FolderOpen : Folder;
          return (
            <div
              // Kind-qualified: a hand-crafted archive can hold both a file
              // `docs` and a `docs/…` directory, which share a path.
              key={`${row.kind}:${row.path}`}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-setsize={row.setSize}
              aria-posinset={row.posInSet}
              aria-expanded={row.kind === "dir" ? row.expanded : undefined}
              aria-selected={row.kind === "file" ? isSelected : undefined}
              tabIndex={row.path === tabbablePath ? 0 : -1}
              data-tree-focused={isFocused ? "true" : undefined}
              onFocus={() => setFocusedPath(row.path)}
              onClick={() => {
                setFocusedPath(row.path);
                if (row.kind === "dir") toggleDir(row.path, !row.expanded);
                else onSelect(row.path);
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
              {row.kind === "dir" ? (
                row.expanded ? (
                  <ChevronDown size={12} className="shrink-0" aria-hidden />
                ) : (
                  <ChevronRight size={12} className="shrink-0" aria-hidden />
                )
              ) : (
                <span className="w-3 shrink-0" aria-hidden />
              )}
              <Icon size={13} className="shrink-0 opacity-70" aria-hidden />
              <span className="truncate">{row.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
