// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { useAuiState } from "@assistant-ui/react";
import { selectedModelReading, type SelectedReading } from "./model-fit.ts";
import { useChatHost } from "./runtime-context.ts";
import { latestConversationContext, type ConversationContext } from "./turn-context.ts";

const MeasureContext = React.createContext<ConversationContext | null>(null);

/**
 * Reads the conversation's last measure once for every consumer below it. The selector returns a
 * string, which a streamed delta leaves equal: this re-renders only when a turn settles a measure.
 */
export function ConversationContextProvider({ children }: { children: React.ReactNode }) {
  const snapshot = useAuiState((s) => JSON.stringify(latestConversationContext(s.thread.messages)));
  const measured = React.useMemo(
    () => JSON.parse(snapshot) as ConversationContext | null,
    [snapshot],
  );
  return React.createElement(MeasureContext.Provider, { value: measured }, children);
}

/** The conversation's last measure, read against the selected model; `null` before any. */
export function useConversationContext(): SelectedReading | null {
  const measured = React.useContext(MeasureContext);
  const { modelId, modelSizing } = useChatHost();
  return React.useMemo(
    () => (measured ? selectedModelReading(measured, modelId, modelSizing) : null),
    [measured, modelId, modelSizing],
  );
}
