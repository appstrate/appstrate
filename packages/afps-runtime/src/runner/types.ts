// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS 1.3 Runner surface.
 *
 * A {@link Runner} takes a loaded bundle + execution context, wires the
 * spec resolvers ({@link SkillResolver} and the bundled context source),
 * dispatches tool invocations to the LLM, and emits the resulting
 * {@link RunEvent}s to the caller's {@link EventSink}. Tools come from
 * spawned `mcp-server` packages and integrations; credentialled HTTP
 * (integration `api_call`) is wired by the runner implementation as
 * pre-built tools, not via a generic in-process resolver.
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
import type { SkillResolver } from "../resolvers/types.ts";

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
   * of skills from an external registry, etc.).
   */
  skillResolver?: SkillResolver;

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
