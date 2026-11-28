// SPDX-License-Identifier: Apache-2.0

import { LOCAL_STORAGE_KEYS, createLocalStore, jsonCodec } from "@appstrate/ui/local-storage";

export type ListView = "cards" | "table";

/** Cards-or-table preference, persisted per SCREEN (`list`) and kept out of the URL (a preference, not a location). */
const listViews = createLocalStore(
  LOCAL_STORAGE_KEYS.listView,
  jsonCodec((value): ListView | null => (value === "cards" || value === "table" ? value : null)),
);

export function useListView(list: string): [ListView, (view: ListView) => void] {
  const [view, setView] = listViews.useValue(list);
  const defaultView = list === "integrations" || list === "documents" ? "cards" : "table";
  return [view ?? defaultView, setView];
}

export type RolesView = "list" | "matrix";

/** The roles page's list-or-permission-matrix choice: a presentation of the same roles, kept like cards-or-table. */
const rolesViews = createLocalStore(
  LOCAL_STORAGE_KEYS.rolesView,
  jsonCodec((value): RolesView | null => (value === "list" || value === "matrix" ? value : null)),
);

export function useRolesView(): [RolesView, (view: RolesView) => void] {
  const [view, setView] = rolesViews.useValue();
  return [view ?? "list", setView];
}
