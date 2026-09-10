// SPDX-License-Identifier: Apache-2.0
import { useEffect } from "react";
import { Controls, Panel, useStore, useReactFlow } from "@xyflow/react";
import { Maximize2, Minimize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";

const FIT_VIEW_OPTIONS = { padding: 0.06, maxZoom: 1 } as const;

/**
 * Reframe after React Flow has measured its canvas, not before its store updates.
 * Do not depend on hover or useNodesInitialized: hidden handles can keep that
 * hook false indefinitely. Initial framing belongs to React Flow's fitView prop.
 */
function FitOnCanvasResize() {
  const canvasSize = useStore((s) => `${Math.round(s.width)}x${Math.round(s.height)}`);
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (canvasSize === "0x0") return; // bootstrap frame, nothing measured yet
    void fitView(FIT_VIEW_OPTIONS);
  }, [fitView, canvasSize]);
  return null;
}

export function MapControls({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const { t } = useTranslation("agent-map");
  return (
    <>
      <Controls position="top-right" showInteractive={false} style={{ top: 34 }} />
      <Panel position="top-right">
        <TooltipProvider delayDuration={250}>
          <Tooltip>
            <div className="react-flow__controls">
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="react-flow__controls-button"
                  onClick={onToggle}
                  aria-label={expanded ? t("agent-map:collapse") : t("agent-map:expand")}
                >
                  {expanded ? <Minimize2 /> : <Maximize2 />}
                </button>
              </TooltipTrigger>
            </div>
            <TooltipContent side="left">
              {expanded ? t("agent-map:collapse") : t("agent-map:expand")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </Panel>
      <FitOnCanvasResize />
    </>
  );
}
