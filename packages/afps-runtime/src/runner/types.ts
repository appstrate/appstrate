// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS 1.3 Runner surface.
 *
 * A {@link Runner} takes a loaded bundle + execution context, wires the
 * spec resolvers ({@link ToolResolver}, {@link SkillResolver}, and the
 * bundled context source), dispatches tool invocations to the LLM, and
 * emits the resulting {@link RunEvent}s to the caller's {@link EventSink}.
 * Credentialled HTTP (integration `api_call`) is wired by the runner
 * implementation as pre-built tools, not via this generic surface.
 *
 * The runtime ships this interface as the canonical execution contract;
 * individual implementations (Pi SDK backend, mock replay, remote
 * delegation, etc.) live outside this package.
 *
 * Specification: `afps-spec/spec.md` §8, spec document §5.
 */

import type { EventSink } from "../interfaces/event-sink.ts";
import type { Bundle } from "../bundle/types.ts";
import type { ExecutionContext } from "../types/execution-context.ts";
import type { SkillResolver, Tool, ToolResolver } from "../resolvers/types.ts";

export interface RunOptions {
  /** Already-loaded {@link Bundle} (root package + transitively resolved deps). */
  bundle: Bundle;
  /** Per-run execution context — runId, input, template vars. */
  context: ExecutionContext;

  /** Business terminus — receives every RunEvent the tools emit. */
  eventSink: EventSink;

  /**
   * Internal resolvers — defaulted by the runner to the Bundled*
   * implementations. Override only for advanced cases (custom resolution
   * of tools from an external registry, etc.).
   */
  toolResolver?: ToolResolver;
  skillResolver?: SkillResolver;

  /**
   * Per-tool override, applied AFTER the ToolResolver result. Use this
   * to swap a single tool (e.g. an in-memory `@afps/memory` in tests)
   * without replacing the whole resolver.
   */
  toolOverrides?: Record<string, Tool>;

  /** Cancellation token. Runner MUST stop emitting and reject if aborted. */
  signal?: AbortSignal;
}

/**
 * Execution surface: take a loaded bundle + execution context, wire the
 * resolvers, dispatch tools to the LLM, emit RunEvents to the sink.
 */
export interface Runner {
  readonly name: string;
  run(options: RunOptions): Promise<void>;
}
