// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { ContextProvider } from "../interfaces/context-provider.ts";
import type { ExecutionContext } from "../types/execution-context.ts";
import { renderTemplate } from "../template/mustache.ts";

/**
 * The "view" shape made available to a prompt template at render time.
 * Intentionally a plain projection — logic-less Mustache only reads
 * properties, so anything surfaced here is trivially explainable to a
 * reviewer and cannot execute code. Unknown/missing keys render as the
 * empty string (Mustache spec).
 *
 * Stability contract: new fields MAY be added, existing fields MUST NOT
 * change shape. Consumer templates should treat the view as
 * forward-compatible.
 */
export interface PromptView {
  /** Unique identifier for this execution. */
  runId: string;
  /** User / caller-supplied input, passed through verbatim. */
  input: unknown;
  /**
   * Agent configuration values resolved for this run (from the agent's
   * `config` schema + caller overrides). Passed through verbatim so
   * templates can reference `{{config.*}}`. Absent when the agent
   * declares no config.
   */
  config?: Record<string, unknown>;
  /** Prior memories, most recent first. Empty array when none. */
  memories: ReadonlyArray<{ content: string; createdAt: number }>;
  /** Snapshot of the agent's previous state. `null` if none. */
  state: unknown;
  /** Recent run summaries, most recent first. Empty array when none. */
  history: ReadonlyArray<{ runId: string; timestamp: number; output: unknown }>;
}

export interface RenderPromptOptions {
  /** The `prompt.md` template shipped in the bundle. */
  template: string;
  /** Execution context providing `runId`, `input`, and baseline fallbacks. */
  context: ExecutionContext;
  /** Source for pull-side data (memories, state, history). */
  provider: ContextProvider;
  /** Cap memory count injected into the prompt. Default: 50. */
  memoryLimit?: number;
  /** Cap history entries injected into the prompt. Default: 10. */
  historyLimit?: number;
}

/**
 * Resolve the final agent prompt by:
 *
 * 1. pulling memories / state / history from the {@link ContextProvider}
 *    (with {@link ExecutionContext} values used as fallbacks when the
 *    context already carries a snapshot),
 * 2. assembling a {@link PromptView}, and
 * 3. rendering the template against it using logic-less Mustache.
 *
 * This function is the single entrypoint for the render half of the
 * "pure template / impure context" separation described in
 * `AFPS_EXTENSION_ARCHITECTURE.md` §3.2 — the output depends only on the
 * template + view, never on hidden I/O during rendering.
 */
export async function renderPrompt(opts: RenderPromptOptions): Promise<string> {
  const view = await buildPromptView(opts);
  return renderTemplate(opts.template, view);
}

/**
 * Build the {@link PromptView} without rendering. Exposed so callers
 * can inspect the exact data a template would receive — useful for
 * debug dumps, reproducibility checks, and bundle validation.
 */
export async function buildPromptView(
  opts: Omit<RenderPromptOptions, "template">,
): Promise<PromptView> {
  const { context, provider } = opts;
  const memoryLimit = opts.memoryLimit ?? 50;
  const historyLimit = opts.historyLimit ?? 10;

  const [memories, state, history] = await Promise.all([
    resolveMemories(context, provider, memoryLimit),
    resolveState(context, provider),
    resolveHistory(context, provider, historyLimit),
  ]);

  return {
    runId: context.runId,
    input: context.input,
    ...(context.config !== undefined ? { config: context.config } : {}),
    memories,
    state,
    history,
  };
}

async function resolveMemories(
  context: ExecutionContext,
  provider: ContextProvider,
  limit: number,
): Promise<PromptView["memories"]> {
  if (context.memories && context.memories.length > 0) {
    return context.memories.slice(0, limit);
  }
  const fetched = await provider.getMemories({ limit });
  return fetched;
}

async function resolveState(
  context: ExecutionContext,
  provider: ContextProvider,
): Promise<unknown> {
  if (context.state !== undefined) return context.state;
  return await provider.getState();
}

async function resolveHistory(
  context: ExecutionContext,
  provider: ContextProvider,
  limit: number,
): Promise<PromptView["history"]> {
  if (context.history && context.history.length > 0) {
    return context.history.slice(0, limit);
  }
  return await provider.getHistory({ limit });
}
