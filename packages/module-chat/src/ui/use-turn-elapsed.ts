// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { useAuiState } from "@assistant-ui/react";

/**
 * Time since the turn started, ticking each second while `running`, frozen
 * once it stops. Counted from the message's creation, so the loading line and
 * the thought block that replaces it show one continuous clock. Undefined for
 * a block never seen running (a turn loaded from history).
 */
export function useTurnElapsedMs(running: boolean): number | undefined {
  const createdAt = useAuiState((s) => s.message.createdAt?.getTime() ?? 0);
  const [seenRunning, setSeenRunning] = React.useState(running);
  if (running && !seenRunning) setSeenRunning(true);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(id);
      // The clock stops on the moment the turn does, not on its last tick.
      setNow(Date.now());
    };
  }, [running]);
  if (!seenRunning || !createdAt) return undefined;
  return Math.max(0, now - createdAt);
}
