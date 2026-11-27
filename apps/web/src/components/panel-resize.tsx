// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@appstrate/ui/cn";
import { keyedWidth } from "@/lib/panel-resize-keys";

/**
 * A vertical separator on a panel's `edge`: drag (pointer capture), arrow
 * keys, Home/End, double-click to reset. The panel grows toward that edge (the
 * chat's context panel from its left one, the chat's sidebar from its right).
 * `onDraggingChange` lets the panel drop its width transition while the pointer
 * drives it. `clamp` may be tighter than `width` (a window narrowed since it was
 * stored): drags and keys start from the clamped width, the one on screen.
 */
export function PanelResizeHandle({
  edge = "left",
  controls,
  label,
  width,
  min,
  max,
  clamp,
  onLive,
  onCommit,
  onDraggingChange,
  className,
}: {
  edge?: "left" | "right";
  controls: string;
  label: string;
  width: number;
  min: number;
  max: number;
  clamp: (width: number) => number;
  onLive: (width: number) => void;
  onCommit: (width: number | null) => void;
  onDraggingChange: (dragging: boolean) => void;
  className?: string;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  // Set once the pointer moved during the drag: the store already follows `onLive` by then.
  const moved = useRef(false);
  const latest = useRef(width);
  // The handle unmounts mid-drag when the panel collapses or the window turns mobile: the cleanup
  // ends the drag with the callbacks of the last render.
  const callbacks = useRef({ onCommit, onDraggingChange });
  useEffect(() => {
    callbacks.current = { onCommit, onDraggingChange };
  });

  const endDrag = () => {
    const started = drag.current;
    if (!started) return;
    drag.current = null;
    callbacks.current.onDraggingChange(false);
    // A click without a move keeps the stored width as it is (null = the default); any move
    // commits, even back to the starting width, so the store and the storage agree.
    if (moved.current) callbacks.current.onCommit(latest.current);
  };
  // Unmount only: `endDrag` reads nothing but refs.
  useEffect(() => endDrag, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width: clamp(width) };
    latest.current = drag.current.width;
    moved.current = false;
    onDraggingChange(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // The panel grows as the pointer moves past its edge.
    const delta = event.clientX - drag.current.x;
    moved.current = true;
    latest.current = clamp(drag.current.width + (edge === "left" ? -delta : delta));
    onLive(latest.current);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = keyedWidth(event.key, { edge, width: clamp(width), min, max });
    if (next === null) return;
    event.preventDefault();
    onCommit(clamp(next));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={Number.isFinite(max) ? Math.round(max) : undefined}
      tabIndex={0}
      className={cn(
        "hover:bg-primary/20 focus-visible:bg-primary/30 absolute inset-y-0 z-10 w-1.5 cursor-col-resize touch-none transition-colors outline-none",
        edge === "left" ? "left-0" : "right-0",
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onCommit(null)}
    />
  );
}
