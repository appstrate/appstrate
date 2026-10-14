// SPDX-License-Identifier: Apache-2.0
import { MarkerType, type Edge } from "@xyflow/react";

/** The edge grammar of an integration's structure map. */
export function styleMapEdge(edge: Edge, kind: "dependency" | "resolution"): Edge {
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
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: "var(--muted-foreground)",
      width: 12,
      height: 12,
    },
    style: {
      stroke: "var(--muted-foreground)",
      strokeWidth: 1.75,
      strokeDasharray: "7 5",
    },
    zIndex: 3,
  };
}
