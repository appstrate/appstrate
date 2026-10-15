// SPDX-License-Identifier: Apache-2.0

/**
 * An integration editor section, in the surface it is drawn on.
 *
 * On the editor PAGE a section is a titled card. In the edit PANEL the rail
 * already names the section and the panel heads it, so a card title under that
 * heading said the same word twice: there the section is its fields, with its
 * own action (add an auth, add a policy) at the top right — the agent bundle
 * editor's `surface="settings"`, applied the same way.
 */
import type { ReactNode } from "react";
import { SectionCard } from "../section-card";

export type EditorSurface = "card" | "settings";

export function EditorSection({
  surface,
  title,
  headerRight,
  children,
}: {
  surface: EditorSurface;
  title: string;
  headerRight?: ReactNode;
  children: ReactNode;
}) {
  if (surface === "settings") {
    return (
      <section className="max-w-2xl space-y-5">
        {headerRight && <div className="flex justify-end">{headerRight}</div>}
        {children}
      </section>
    );
  }
  return (
    <SectionCard title={title} headerRight={headerRight}>
      {children}
    </SectionCard>
  );
}
