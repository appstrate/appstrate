// SPDX-License-Identifier: Apache-2.0

/**
 * Side panel for HTML artifacts (Claude/ChatGPT style). The thread shows a
 * minimal, non-interactive card; clicking it opens the real, interactive
 * rendering here — the iframe lives only in the panel (no double render).
 *
 * Pure front: the artifact code travels in the render_html tool call; nothing
 * here touches Appstrate. The opener flows through a per-ChatPage React context
 * (no global store), so an embedded ChatPanel without a panel just no-ops.
 */

import { createContext, useContext, useState } from "react";
import { Code2Icon, XIcon } from "lucide-react";

export interface Artifact {
  code: string;
  title?: string;
}

/** Set the open artifact (or null to close). Null when no panel is mounted. */
export const ArtifactPanelContext = createContext<((a: Artifact) => void) | null>(null);
export const useOpenArtifact = () => useContext(ArtifactPanelContext);

const ARTIFACT_TABS = [
  ["preview", "Aperçu"],
  ["source", "Source"],
] as const;
type ArtifactTab = (typeof ARTIFACT_TABS)[number][0];

/** Full-height artifact panel — the page mounts it beside the thread. */
export function ArtifactPanel({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const [tab, setTab] = useState<ArtifactTab>("preview");
  const { code, title } = artifact;
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Code2Icon className="text-muted-foreground size-4 shrink-0" />
        <span className="flex-1 truncate text-sm font-medium">{title ?? "Artifact HTML"}</span>
        <div className="flex gap-1">
          {ARTIFACT_TABS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={`rounded-md px-2 py-0.5 text-xs transition-colors ${
                tab === value
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          title="Fermer"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      {tab === "preview" ? (
        // sandbox WITHOUT allow-same-origin: the generated document cannot
        // touch our DOM, cookies, or origin — only run its own scripts.
        <iframe
          title={title ?? "Artifact"}
          sandbox="allow-scripts"
          className="min-h-0 w-full flex-1 bg-white"
          srcDoc={code}
        />
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto px-3 py-2 text-xs whitespace-pre-wrap">
          {code}
        </pre>
      )}
    </div>
  );
}
