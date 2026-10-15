// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext } from "react";

/**
 * The few strings the primitives of this package render themselves (a dialog's
 * close button, the copy button, the sidebar's screen-reader chrome, a carousel's arrows). The package carries no
 * i18n runtime: the host application provides its translations once, at its
 * root, and every primitive reads them from there. English is the default.
 */
interface UiLabels {
  carouselNext: string;
  carouselPrevious: string;
  close: string;
  copy: string;
  copied: string;
  copyFailed: string;
  sidebar: string;
  sidebarDescription: string;
  toggleSidebar: string;
}

export const UiLabelsContext = createContext<UiLabels>({
  carouselNext: "Next slide",
  carouselPrevious: "Previous slide",
  close: "Close",
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Could not copy: the browser refused access to the clipboard.",
  sidebar: "Sidebar",
  sidebarDescription: "Displays the mobile sidebar.",
  toggleSidebar: "Toggle Sidebar",
});

export function useUiLabels(): UiLabels {
  return useContext(UiLabelsContext);
}
