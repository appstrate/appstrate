// SPDX-License-Identifier: Apache-2.0

/**
 * Framework-neutral structural views of the Pi SDK event shapes the chat engine
 * consumes.
 *
 * They stay declared here rather than aliased to the vendor union for two
 * reasons that have nothing to do with typing: the UI-stream mapper must be
 * unit-testable with synthetic events (a real `AssistantMessage` payload per
 * fixture would be pure noise), and it must carry no eager Pi-SDK import — the
 * heavy `@earendil-works/pi-coding-agent` graph loads only inside the engine,
 * via `loadPiCodingAgentSdk()`.
 *
 * What they no longer rely on is a human keeping them in step. The
 * conformance block at the bottom of this file asserts, at COMPILE time, that
 * every vendor variant the mapper branches on still fits its view here — a
 * renamed field or a dropped variant in a Pi upgrade is a type error, not a
 * mapper test that happens to notice. The imports it needs are type-only, so
 * they are erased and the lazy-load property is preserved.
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
  | { type: "turn_end"; message: unknown; toolResults: unknown[] }
  | { type: "agent_end"; messages: unknown[] }
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

// ─── Vendor conformance (compile-time only) ────────────────────────────────
//
// Direction matters: VENDOR-must-fit-OURS, never the reverse. Our views are
// deliberately narrower (payloads left `unknown`, variants we ignore omitted),
// so requiring ours to fit the vendor's would fail for reasons that are by
// design. Each assertion below reads "Pi's own `X` event still satisfies
// everything the mapper reads off it".

import type {
  PiSdkAgentSessionEvent,
  PiSdkAssistantMessageEvent,
  PiSdkUsage,
} from "@appstrate/runner-pi";

/** Resolves to `true`, or to a diagnostic object that fails {@link Assert}. */
type Conforms<Vendor, Ours> = [Vendor] extends [Ours]
  ? true
  : { error: "Pi SDK shape no longer fits this module's view"; vendor: Vendor; ours: Ours };

type Assert<T extends true> = T;

type VendorEvent<K extends string> = Extract<PiSdkAgentSessionEvent, { type: K }>;
type OurEvent<K extends string> = Extract<AgentSessionEvent, { type: K }>;

type VendorStreamEvent<K extends string> = Extract<PiSdkAssistantMessageEvent, { type: K }>;
type OurStreamEvent<K extends string> = Extract<PiAssistantMessageEvent, { type: K }>;

// Session events the mapper branches on.
type _MessageStart = Assert<Conforms<VendorEvent<"message_start">, OurEvent<"message_start">>>;
type _MessageUpdate = Assert<Conforms<VendorEvent<"message_update">, OurEvent<"message_update">>>;
type _MessageEnd = Assert<Conforms<VendorEvent<"message_end">, OurEvent<"message_end">>>;
type _TurnEnd = Assert<Conforms<VendorEvent<"turn_end">, OurEvent<"turn_end">>>;
type _AgentEnd = Assert<Conforms<VendorEvent<"agent_end">, OurEvent<"agent_end">>>;
type _ToolEnd = Assert<Conforms<VendorEvent<"tool_execution_end">, OurEvent<"tool_execution_end">>>;

// Assistant-stream events the mapper branches on. Asserted per variant, not on
// the whole union: a NEW streaming variant Pi adds and the mapper ignores is
// not a defect, but a renamed field on one we DO read is.
type _StreamTextStart = Assert<
  Conforms<VendorStreamEvent<"text_start">, OurStreamEvent<"text_start">>
>;
type _StreamTextDelta = Assert<
  Conforms<VendorStreamEvent<"text_delta">, OurStreamEvent<"text_delta">>
>;
type _StreamTextEnd = Assert<Conforms<VendorStreamEvent<"text_end">, OurStreamEvent<"text_end">>>;
type _StreamThinkingStart = Assert<
  Conforms<VendorStreamEvent<"thinking_start">, OurStreamEvent<"thinking_start">>
>;
type _StreamThinkingDelta = Assert<
  Conforms<VendorStreamEvent<"thinking_delta">, OurStreamEvent<"thinking_delta">>
>;
type _StreamThinkingEnd = Assert<
  Conforms<VendorStreamEvent<"thinking_end">, OurStreamEvent<"thinking_end">>
>;
type _StreamToolCallEnd = Assert<
  Conforms<VendorStreamEvent<"toolcall_end">, OurStreamEvent<"toolcall_end">>
>;
type _StreamError = Assert<Conforms<VendorStreamEvent<"error">, OurStreamEvent<"error">>>;

// Usage is consumed whole (every counter is read), so it is pinned in BOTH
// directions: a field the vendor adds is a field the chat's usage record is
// silently dropping.
type _UsageVendorFitsOurs = Assert<Conforms<PiSdkUsage, PiUsage>>;
type _UsageOursFitVendor = Assert<Conforms<PiUsage, PiSdkUsage>>;

/**
 * One anchor so the assertions above are referenced rather than pruned as
 * unused declarations. Every member is `true` when it conforms, so the
 * intersection is `true`; a member that drifted resolves to a diagnostic
 * object instead and fails its own `Assert<…>` constraint, naming the exact
 * event that moved. Same idiom as `_assertApiShapeSubsetOfPi` in
 * `@appstrate/runner-pi`.
 */
type VendorConformance = _MessageStart &
  _MessageUpdate &
  _MessageEnd &
  _TurnEnd &
  _AgentEnd &
  _ToolEnd &
  _StreamTextStart &
  _StreamTextDelta &
  _StreamTextEnd &
  _StreamThinkingStart &
  _StreamThinkingDelta &
  _StreamThinkingEnd &
  _StreamToolCallEnd &
  _StreamError &
  _UsageVendorFitsOurs &
  _UsageOursFitVendor;

const _assertVendorConformance: VendorConformance = true;
void _assertVendorConformance;
