// SPDX-License-Identifier: Apache-2.0

/**
 * A detail page's Paramètres: its sections in a rail, the open one beside it.
 * One query parameter names the section, `?file=` the file it opens on, and
 * the tab lives in the hash (`lib/settings-section-href.ts`). `resolve` turns
 * what the URL asks for into the section shown, so a section the reader may
 * not open falls back the same way for the panel and for the unsaved-changes
 * guard (`EditorPlaceContext`).
 */
import { useCallback, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { EditorPlaceContext } from "../../hooks/use-unsaved-changes";
import type { EditorPlace } from "../../lib/editor-place";
import { sectionHref, settingsEditorPlace } from "../../lib/settings-section-href";
import { AgentDetailSplit } from "../agent-detail/agent-detail-split";
import { SectionRail, type SectionRailItem } from "./section-rail";

/** A section's address on this page; `extra` names what opens inside it (a file, a modal). */
export type SettingsHref<S extends string> = (section: S, extra?: Record<string, string>) => string;

export interface SettingsRailGroup<S extends string> {
  title: string;
  items: ReadonlyArray<Omit<SectionRailItem, "id" | "to"> & { id: S }>;
}

export function SettingsRailView<S extends string>({
  param,
  tab,
  label,
  groups,
  resolve,
  definitionSections,
  children,
}: {
  param: string;
  tab: string;
  /** The rail's name, and the phone menu's. */
  label: string;
  groups: ReadonlyArray<SettingsRailGroup<S>>;
  resolve: (requested: string | null) => S;
  /** The sections one editor serves, switched without leaving it. */
  definitionSections?: readonly string[];
  children: (open: { active: S; file: string | undefined; href: SettingsHref<S> }) => ReactNode;
}) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const active = resolve(params.get(param));
  const href: SettingsHref<S> = (section, extra) =>
    sectionHref(location.pathname, tab, param, section, extra);
  const editorPlace = useCallback<EditorPlace>(
    (search) => settingsEditorPlace(resolve(search.get(param)), search, definitionSections),
    [resolve, param, definitionSections],
  );

  return (
    <EditorPlaceContext.Provider value={editorPlace}>
      <AgentDetailSplit
        phoneMenu={label}
        rail={
          <SectionRail
            label={label}
            active={active}
            groups={groups.map((group) => ({
              title: group.title,
              items: group.items.map((item) => ({ ...item, to: href(item.id) })),
            }))}
          />
        }
      >
        {children({ active, file: params.get("file") ?? undefined, href })}
      </AgentDetailSplit>
    </EditorPlaceContext.Provider>
  );
}
