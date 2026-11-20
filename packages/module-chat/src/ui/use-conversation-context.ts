// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { useAuiState } from "@assistant-ui/react";
import { selectedModelReading, type SelectedReading } from "./model-fit.ts";
import { useChatHost } from "./runtime-context.ts";
import { latestConversationContext } from "./turn-context.ts";

/** The conversation's last measure, read against the selected model; `null` before any. */
export function useConversationContext(): SelectedReading | null {
  const { modelId, modelSizing } = useChatHost();
  const messages = useAuiState((s) => s.thread.messages);
  return React.useMemo(() => {
    const measured = latestConversationContext(messages);
    return measured ? selectedModelReading(measured, modelId, modelSizing) : null;
  }, [messages, modelId, modelSizing]);
}
