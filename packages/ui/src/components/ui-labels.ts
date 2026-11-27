// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext } from "react";

/** Hosts can translate a key alone or supply interpolation values. */
export interface Translate<Values> {
  (key: string): string;
  (key: string, values: Values): string;
}

/**
 * The few strings the primitives of this package render themselves (the copy button, a dialog's close button, an
 * explanation's ⓘ button, the sidebar's screen-reader chrome). The package carries no
 * i18n runtime: the host application provides its translations once, at its
 * root, and every primitive reads them from there. English is the default.
 */
interface UiLabels {
  close: string;
  sidebar: string;
  sidebarDescription: string;
  toggleSidebar: string;
  breadcrumb: string;
  breadcrumbMore: string;
  copy: string;
  copied: string;
  copyFailed: string;
  moreInfo: string;
}

export const UiLabelsContext = createContext<UiLabels>({
  close: "Close",
  sidebar: "Sidebar",
  sidebarDescription: "Displays the mobile sidebar.",
  toggleSidebar: "Toggle Sidebar",
  breadcrumb: "Breadcrumb",
  breadcrumbMore: "More items",
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Could not copy: the browser refused access to the clipboard.",
  moreInfo: "More information",
});

export function useUiLabels(): UiLabels {
  return useContext(UiLabelsContext);
}
