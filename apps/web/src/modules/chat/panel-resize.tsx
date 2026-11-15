// SPDX-License-Identifier: Apache-2.0

import { useRef, type KeyboardEvent, type PointerEvent } from "react";

const KEY_STEP = 24;

/**
 * A vertical separator on the panel's left edge: drag (pointer capture),
 * arrow keys, Home/End, double-click to reset. `onDraggingChange` lets the
 * panel drop its width transition while the pointer drives it.
 */
export function PanelResizeHandle({
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
    // The panel grows as the pointer moves left.
    latest.current = clamp(drag.current.width + drag.current.x - event.clientX);
    onLive(latest.current);
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    onDraggingChange(false);
    onCommit(latest.current);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === "ArrowLeft"
        ? width + KEY_STEP
        : event.key === "ArrowRight"
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
      className="hover:bg-primary/20 focus-visible:bg-primary/30 absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none transition-colors outline-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onCommit(null)}
    />
  );
}
