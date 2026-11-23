// SPDX-License-Identifier: Apache-2.0

import * as React from "react";

const MOBILE_BREAKPOINT = 768;

/** Below Tailwind's `md` (48rem): the phone layout. */
const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

/**
 * Below `md`, live: re-renders when the width crosses it. `DropdownMenu` and `Popover` read it to
 * draw their content as a sheet from the bottom.
 */
export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean>(
    () => typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT,
  );

  React.useEffect(() => {
    const mql = window.matchMedia(MOBILE_MEDIA_QUERY);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
