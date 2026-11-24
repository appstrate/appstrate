// SPDX-License-Identifier: Apache-2.0

import * as React from "react";

/** Provided by `ThoughtGroup` (`reasoning.tsx`) around the steps it lists. */
export const ThoughtGroupContext = React.createContext(false);

/** True inside a thought block: tool rows render quiet, errors included. */
export function useInThoughtGroup(): boolean {
  return React.useContext(ThoughtGroupContext);
}
