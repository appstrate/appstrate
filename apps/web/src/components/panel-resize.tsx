// SPDX-License-Identifier: Apache-2.0

import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@appstrate/ui/cn";

const KEY_STEP = 24;

/**
 * A vertical separator on a panel's edge: drag (pointer capture), arrow keys,
 * Home/End, double-click to reset. `onDraggingChange` lets the panel drop its
 * width transition while the pointer drives it. `edge` is the side it sits on:
 * the panel grows toward it (the chat's context panel from its left edge, the
 * chat's sidebar from its right one).
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
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const latest = useRef(width);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width };
    latest.current = width;
    onDraggingChange(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // The panel grows as the pointer moves away from it, past its edge.
    const moved = event.clientX - drag.current.x;
    latest.current = clamp(drag.current.width + (edge === "left" ? -moved : moved));
    onLive(latest.current);
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    onDraggingChange(false);
    onCommit(latest.current);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The arrow pointing past the edge widens the panel.
    const grow = edge === "left" ? "ArrowLeft" : "ArrowRight";
    const shrink = edge === "left" ? "ArrowRight" : "ArrowLeft";
    const next =
      event.key === grow
        ? width + KEY_STEP
        : event.key === shrink
          ? width - KEY_STEP
          : event.key === "Home"
            ? min
            : event.key === "End" && Number.isFinite(max)
              ? max
              : null;
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
