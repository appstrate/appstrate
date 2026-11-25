// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";

/** What a live region reads of `text`: nothing until it differs from its value when first `ready`. */
export function useChangeAnnouncement(text: string, ready: boolean): string {
  const [opening, setOpening] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  if (opening === null) {
    if (ready) setOpening(text);
  } else if (!changed && text !== opening) {
    setChanged(true);
  }
  return changed ? text : "";
}
