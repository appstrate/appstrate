// SPDX-License-Identifier: Apache-2.0

/**
 * Framework-neutral structural views of the Pi SDK event shapes the chat engine
 * consumes. Declared here (not imported from the Pi SDK) so the UI-stream mapper
 * is unit-testable with synthetic events and carries no eager Pi-SDK import — the
 * heavy `@mariozechner/pi-coding-agent` graph loads only inside the engine, via
 * `loadPiCodingAgentSdk()`. These mirror `@mariozechner/pi-agent-core`'s
 * `AgentSessionEvent` and `@mariozechner/pi-ai`'s `Usage` (v0.73.1); a shape
 * drift surfaces as a mapper test failure, not a silent miss.
 */

/** Mirror of pi-ai `Usage`. */
export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/** UI-message-stream finish reasons this engine emits. */
export type PiFinishReason = "stop" | "length" | "tool-calls" | "error" | "other";

/** The subset of `AgentSessionEvent` the mapper branches on. */
export type AgentSessionEvent =
  | { type: "message_start"; message: unknown }
  | { type: "message_update"; message: unknown; assistantMessageEvent: PiAssistantMessageEvent }
  | { type: "message_end"; message: unknown }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | { type: string; [k: string]: unknown };

/** Mirror of pi-ai `AssistantMessageEvent`. */
export type PiAssistantMessageEvent =
  | { type: "start"; partial: unknown }
  | { type: "text_start"; contentIndex: number; partial: unknown }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: unknown }
  | { type: "text_end"; contentIndex: number; content: string; partial: unknown }
  | { type: "thinking_start"; contentIndex: number; partial: unknown }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: unknown }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: unknown }
  | { type: "toolcall_start"; contentIndex: number; partial: unknown }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: unknown }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: { id: string; name: string; arguments?: Record<string, unknown> };
      partial: unknown;
    }
  | { type: "done"; reason: string; message: unknown }
  | { type: "error"; reason: string; error: unknown };
