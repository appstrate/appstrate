// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { useModalParam } from "./use-modal-param";

/** A map shown full screen is a place: it has an address, `?fullscreenMap=1`. */
export function useMapFullscreen() {
  const param = useModalParam("fullscreenMap");
  const { open, close } = param;
  const expanded = param.value !== null;
  const toggle = useCallback(() => (expanded ? close() : open()), [expanded, open, close]);
  return { expanded, toggle, close };
}
