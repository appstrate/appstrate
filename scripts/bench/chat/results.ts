// SPDX-License-Identifier: Apache-2.0

/**
 * The shape of a bench result file and the metrics read out of it — one table,
 * so `run.ts`'s summaries and `compare.ts`'s deltas cannot name a metric
 * differently or read it from a different field.
 */

import type { TurnTimings } from "./client.ts";
import type { MockProfile } from "./mock-llm.ts";
import type { Summary } from "./stats.ts";
import type { UiTimings } from "./ui.ts";

export const SCENARIOS = ["cold", "warm-new", "follow-up", "idle", "ui"] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** What the mock upstream saw of a turn (absent with a real upstream). */
export interface UpstreamSide {
  upstreamCalls: number;
  /** Platform time before the model is even asked. */
  toUpstreamMs: number | null;
  /** Upstream emitted its first visible token → the client read it. */
  relayMs: number | null;
  reasoningEffort: string | null;
  maxTokens: number | null;
  bodyBytes: number | null;
  toolCount: number | null;
  messageCount: number | null;
}

export interface TurnRecord extends TurnTimings {
  scenario: Exclude<Scenario, "ui">;
  index: number;
  historyLength: number;
  /** Fields of the platform's own phase log lines, joined to the turn. */
  server: Record<string, number | null>;
  upstream: UpstreamSide | null;
}

export interface UiRecord extends UiTimings {
  scenario: "ui";
  index: number;
}

export interface BenchResult {
  label: string;
  at: string;
  checkout: string;
  gitHead: string;
  /** False when the run stopped early (a failed boot, Ctrl-C): `records` holds what was measured. */
  complete: boolean;
  infra: string;
  netLatencyMs: number;
  upstream: string;
  mockProfile: MockProfile | null;
  /** `--env` keys only: the values may be secrets. */
  extraEnvKeys: string[];
  extraBody: Record<string, unknown>;
  runs: number;
  warmup: number;
  boots: Summary | null;
  summary: Record<string, Record<string, Summary | null>>;
  records: (TurnRecord | UiRecord)[];
}

/** Metric name → path into a turn record (`cold`, `warm-new`, `follow-up`, `idle`). */
export const TURN_METRICS: Record<string, readonly string[]> = {
  headers: ["headersMs"],
  firstVisible: ["firstVisibleMs"],
  firstText: ["firstTextMs"],
  end: ["endMs"],
  toUpstream: ["upstream", "toUpstreamMs"],
  relay: ["upstream", "relayMs"],
  preamble: ["server", "preambleMs"],
  phaseA: ["server", "phaseAMs"],
  phaseB: ["server", "phaseBMs"],
  claimTurn: ["server", "claimTurnMs"],
  mcpHandshake: ["server", "mcpHandshakeMs"],
  construction: ["server", "constructionMs"],
  firstModelEvent: ["server", "firstModelEventMs"],
  llmProxyTtfb: ["server", "llmProxyFirstMs"],
};

/** Metric name → path into a `ui` record. */
export const UI_METRICS: Record<string, readonly string[]> = {
  dots: ["dotsMs"],
  firstText: ["firstTextMs"],
  blank: ["blankMs"],
  lastText: ["lastTextMs"],
  longTaskMs: ["longTaskMs"],
  slowFrames: ["slowFrames"],
  maxFrame: ["maxFrameMs"],
};

export const metricsOf = (scenario: string) => (scenario === "ui" ? UI_METRICS : TURN_METRICS);

export function metricValue(record: object, path: readonly string[]): number | null {
  let v: unknown = record;
  for (const key of path) v = (v as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The turns of `scenario` that completed: a failed turn has no timing worth comparing. */
export const completed = (records: readonly (TurnRecord | UiRecord)[], scenario: string) =>
  records.filter((r) => r.scenario === scenario && !r.error);
