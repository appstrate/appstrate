// SPDX-License-Identifier: Apache-2.0

import { useAuiState } from "@assistant-ui/react";
import { useLiveElapsedMs } from "@appstrate/ui/use-live-elapsed-ms";
import { useChatHost } from "./runtime-context.ts";
import { turnClock } from "./turn-status.ts";

/**
 * The turn's clock while `running`, counted from the message's creation (`createdAt`: when the
 * client first saw it), `undefined` under 1 s and once the turn settles: no end time is stored.
 */
export function useTurnClock(running: boolean): string | undefined {
  const { lang } = useChatHost();
  const createdAt = useAuiState((s) => s.message.createdAt?.toISOString());
  return turnClock(useLiveElapsedMs(running ? createdAt : null), lang);
}
