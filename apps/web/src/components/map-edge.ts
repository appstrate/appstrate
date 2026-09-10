// SPDX-License-Identifier: Apache-2.0
import { MarkerType, type Edge } from "@xyflow/react";

/** The common edge grammar used by agent and integration maps. */
export function styleMapEdge(
  edge: Edge,
  kind: "flow" | "dependency" | "resolution",
  bidirectional = false,
): Edge {
  if (kind === "flow") {
    return {
      ...edge,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, color: "var(--foreground)" },
      animated: false,
      style: { stroke: "var(--foreground)", strokeWidth: 3 },
      zIndex: 3,
    };
  }
  if (kind === "dependency") {
    return {
      ...edge,
      type: "smoothstep",
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: "var(--muted-foreground)",
        width: 12,
        height: 12,
      },
      animated: false,
      style: {
        stroke: "color-mix(in oklab, var(--muted-foreground) 70%, transparent)",
        strokeWidth: 1.25,
      },
      zIndex: 3,
    };
  }
  return {
    ...edge,
    type: "smoothstep",
    animated: false,
    ...(bidirectional
      ? {
          markerStart: {
            type: MarkerType.ArrowClosed,
            color: "var(--muted-foreground)",
            width: 14,
            height: 14,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: "var(--muted-foreground)",
            width: 14,
            height: 14,
          },
        }
      : {
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: "var(--muted-foreground)",
            width: 12,
            height: 12,
          },
        }),
    style: {
      stroke: "var(--muted-foreground)",
      strokeWidth: 1.75,
      strokeDasharray: "7 5",
    },
    zIndex: 3,
  };
}
