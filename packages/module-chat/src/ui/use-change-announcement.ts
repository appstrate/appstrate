// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";

/**
 * What a live region reads of `text`: nothing until `text` differs from the value it had when it
 * first became `ready`, then `text`. The state a view opens on is not news — a region announcing
 * it would speak on every opening — only a later change is.
 */
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
