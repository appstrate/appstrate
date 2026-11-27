// SPDX-License-Identifier: Apache-2.0

import { useAuiState } from "@assistant-ui/react";
import { useLiveElapsedMs } from "@appstrate/ui/use-live-elapsed-ms";
import { useChatHost } from "./runtime-context.ts";
import { turnClock, turnStartOf } from "./turn-status.ts";

/**
 * The turn's clock while `running`, counted from its user message's creation ({@link turnStartOf}),
 * which holds while the assistant message is swapped for the streamed one; `undefined` under 1 s
 * and once the turn settles: no end time is stored. After a reload mid-turn it counts from the
 * reload: the server does not send the user message's time.
 */
export function useTurnClock(running: boolean): string | undefined {
  const { lang } = useChatHost();
  const startedAt = useAuiState((s) => turnStartOf(s.thread.messages, s.message.index));
  return turnClock(useLiveElapsedMs(running ? startedAt : null), lang);
}
