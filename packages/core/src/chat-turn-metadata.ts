// SPDX-License-Identifier: Apache-2.0

export type ChatTurnEngine = "ai-sdk" | "subscription";
export type ChatTurnFinishReason =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "error"
  | "other"
  | "unknown";

export interface AppstrateTurnMetadata {
  engine: ChatTurnEngine;
  finishReason?: ChatTurnFinishReason;
  stepCount: number;
  maxSteps: number;
  toolStepBudget?: number;
  toolStepBudgetReached?: boolean;
  maxStepsReached: boolean;
  lastToolName?: string;
}

export interface ChatMessageMetadata {
  appstrate?: {
    turn?: AppstrateTurnMetadata;
  };
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeTurnMetadata(
  existing: unknown,
  turn: AppstrateTurnMetadata,
): ChatMessageMetadata {
  const root = isRecord(existing) ? existing : {};
  const appstrate = isRecord(root.appstrate) ? root.appstrate : {};
  return {
    ...root,
    appstrate: {
      ...appstrate,
      turn,
    },
  };
}

export function withTurnMetadata<T extends { metadata?: unknown }>(
  message: T,
  turn: AppstrateTurnMetadata,
): T & { metadata: ChatMessageMetadata } {
  return {
    ...message,
    metadata: mergeTurnMetadata(message.metadata, turn),
  };
}

export function turnMetadataFromMessage(message: unknown): AppstrateTurnMetadata | null {
  if (!isRecord(message)) return null;
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  const appstrate = metadata && isRecord(metadata.appstrate) ? metadata.appstrate : null;
  const turn = appstrate && isRecord(appstrate.turn) ? appstrate.turn : null;
  if (!turn) return null;
  if (turn.engine !== "ai-sdk" && turn.engine !== "subscription") return null;
  if (typeof turn.stepCount !== "number") return null;
  if (typeof turn.maxSteps !== "number") return null;
  if (typeof turn.maxStepsReached !== "boolean") return null;
  return turn as unknown as AppstrateTurnMetadata;
}

export function turnLimitReached(message: unknown): boolean {
  const turn = turnMetadataFromMessage(message);
  return Boolean(turn?.maxStepsReached || turn?.toolStepBudgetReached);
}
