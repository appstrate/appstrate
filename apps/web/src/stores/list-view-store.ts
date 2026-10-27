// SPDX-License-Identifier: Apache-2.0

import { createKeyedLocalStore } from "./local-storage";

export type ListView = "cards" | "table";

/** Cards-or-table preference, persisted per SCREEN (`list`) and kept out of the URL (a preference, not a location). */
const listViews = createKeyedLocalStore<ListView | null>(
  "appstrate-view-",
  (value) => (value === "cards" || value === "table" ? value : null),
  null,
);

export function useListView(list: string): [ListView, (view: ListView) => void] {
  const [view, setView] = listViews.useValue(list);
  const defaultView = list === "integrations" || list === "documents" ? "cards" : "table";
  return [view ?? defaultView, setView];
}
