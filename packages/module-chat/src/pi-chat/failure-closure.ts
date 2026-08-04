// SPDX-License-Identifier: Apache-2.0

import type { UIMessageChunk } from "ai";
import {
  CHAT_MAX_STEPS,
  CHAT_TOOL_STEP_BUDGET,
  CHAT_TURN_DEADLINE_MS,
  mergeTurnMetadata,
} from "@appstrate/core/chat-turn-metadata";
import { resolveTurnClosure, turnDeadlineNoticeText, turnNoticeChunks } from "../turn-closure.ts";
import { classifyClientTurnError, clientTurnErrorMarker } from "../turn-error.ts";

/** Close a subscription turn whose setup or prompt escaped with an exception. */
export function subscriptionFailureChunks(input: {
  error: unknown;
  streamStarted: boolean;
  aborted: boolean;
  abortReason: unknown;
  stepCount: number;
  stepCapReached: boolean;
  lastToolName?: string;
  newId?: () => string;
}): UIMessageChunk[] {
  const newId = input.newId ?? (() => crypto.randomUUID());
  const closure = resolveTurnClosure({
    aborted: input.aborted,
    abortReason: input.abortReason,
    finishReason: input.aborted ? "stop" : "error",
  });
  const clientError = input.aborted ? undefined : classifyClientTurnError(input.error);
  const chunks: UIMessageChunk[] = [];

  if (!input.streamStarted) chunks.push({ type: "start", messageId: newId() });
  if (clientError) {
    chunks.push({ type: "error", errorText: clientTurnErrorMarker(clientError) });
  }
  if (closure.deadlineReached) {
    chunks.push(...turnNoticeChunks(newId(), turnDeadlineNoticeText(CHAT_TURN_DEADLINE_MS)));
  }
  chunks.push({
    type: "finish",
    messageMetadata: mergeTurnMetadata(undefined, {
      engine: "subscription",
      finishReason: closure.finishReason,
      ...(clientError
        ? {
            errorCategory: clientError.category,
            errorRetryable: clientError.retryable,
            ...(clientError.requestId ? { requestId: clientError.requestId } : {}),
          }
        : {}),
      stepCount: input.stepCount,
      maxSteps: CHAT_MAX_STEPS,
      toolStepBudget: CHAT_TOOL_STEP_BUDGET,
      toolStepBudgetReached: input.stepCapReached,
      maxStepsReached: input.stepCapReached,
      ...(input.lastToolName ? { lastToolName: input.lastToolName } : {}),
    }),
  });
  return chunks;
}
