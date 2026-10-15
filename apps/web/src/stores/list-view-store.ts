// SPDX-License-Identifier: Apache-2.0

import { createKeyedLocalStore } from "./local-storage";

export type ListView = "cards" | "table";

/** Cards-or-table preference, persisted per SCREEN (`list`) and kept out of the URL (a preference, not a location). */
const listViews = createKeyedLocalStore<ListView>(
  "appstrate-view-",
  (value) => (value === "cards" ? "cards" : "table"),
  "table",
);

export function useListView(list: string): [ListView, (view: ListView) => void] {
  return listViews.useValue(list);
}
