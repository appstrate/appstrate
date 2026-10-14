// SPDX-License-Identifier: Apache-2.0

import { createKeyedLocalStore } from "./local-storage";

export type ListView = "cards" | "table";

/**
 * Whether a list is drawn as cards or as a table, remembered across reloads.
 *
 * A preference, not a location, so it stays out of the URL: a link to a
 * filtered list should open on the reader's own habit rather than impose the
 * sender's. Same reasoning as the sidebar's open state.
 *
 * One value per SCREEN, named by `list`: switching Skills to cards must not
 * redraw Agents, Integrations or Runs, which the reader never touched.
 */
const listViews = createKeyedLocalStore<ListView>(
  "appstrate-view-",
  (value) => (value === "cards" ? "cards" : "table"),
  "table",
);

export function useListView(list: string): [ListView, (view: ListView) => void] {
  return listViews.useValue(list);
}
