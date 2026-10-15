// SPDX-License-Identifier: Apache-2.0

/** Page: titled card. Panel (`settings`): the rail/panel already names it, so no card title. */
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
      <section className="flex max-w-2xl flex-col gap-5">
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
