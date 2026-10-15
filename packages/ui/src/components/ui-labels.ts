// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext } from "react";

/**
 * The few strings the primitives of this package render themselves (the copy button). The package carries no
 * i18n runtime: the host application provides its translations once, at its
 * root, and every primitive reads them from there. English is the default.
 */
interface UiLabels {
  copy: string;
  copied: string;
  copyFailed: string;
}

export const UiLabelsContext = createContext<UiLabels>({
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Could not copy: the browser refused access to the clipboard.",
});

export function useUiLabels(): UiLabels {
  return useContext(UiLabelsContext);
}
