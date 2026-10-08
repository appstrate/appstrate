// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext } from "react";

/**
 * The few strings the primitives of this package render themselves (a dialog's
 * close button, the sidebar's screen-reader chrome). The package carries no
 * i18n runtime: the host application provides its translations once, at its
 * root, and every primitive reads them from there. English is the default.
 */
interface UiLabels {
  close: string;
  sidebar: string;
  sidebarDescription: string;
  toggleSidebar: string;
}

export const UiLabelsContext = createContext<UiLabels>({
  close: "Close",
  sidebar: "Sidebar",
  sidebarDescription: "Displays the mobile sidebar.",
  toggleSidebar: "Toggle Sidebar",
});

export function useUiLabels(): UiLabels {
  return useContext(UiLabelsContext);
}
