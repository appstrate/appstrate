// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS 1.3 Runner surface.
 *
 * The legacy {@link BundleRunner} / {@link RunBundleOptions} surface in
 * `./types.ts` remains the production shape for now. This module adds
 * the spec-aligned {@link Runner} / {@link RunOptions} shape that
 * substitutes the old `contextProvider` pull-side interface with the
 * four resolver interfaces from the spec.
 *
 * Runners that build against this surface can be migrated incrementally
 * — both surfaces compile against the same `@appstrate/afps-runtime`
 * install and share all other infrastructure (sinks, events, bundles).
 *
 * Specification: `afps-spec/schema/src/interfaces.ts` §8, spec document
 * §5 (Runtime Package).
 */

import type { EventSink } from "../interfaces/event-sink.ts";
import type { LoadedBundle } from "../bundle/loader.ts";
import type { ExecutionContext } from "../types/execution-context.ts";
import type {
  PreludeResolver,
  ProviderResolver,
  SkillResolver,
  Tool,
  ToolResolver,
} from "../resolvers/types.ts";

export interface RunOptions {
  /** Already-loaded bundle (manifest + prompt + files). */
  bundle: LoadedBundle;
  /** Per-run execution context — runId, input, template vars. */
  context: ExecutionContext;

  /**
   * External resolver for `dependencies.providers[]` — REQUIRED when
   * the manifest declares providers. Runner-specific: sidecar, local
   * file, Bitwarden, remote Appstrate, etc. Pass a no-op resolver if
   * the agent has no provider dependencies.
   */
  providerResolver: ProviderResolver;

  /** Business terminus — receives every RunEvent the tools emit. */
  eventSink: EventSink;

  /**
   * Internal resolvers — defaulted by the runner to the Bundled*
   * implementations. Override only for advanced cases (custom resolution
   * of tools from an external registry, etc.).
   */
  toolResolver?: ToolResolver;
  skillResolver?: SkillResolver;
  preludeResolver?: PreludeResolver;

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
 * Implementations of this interface coexist with legacy {@link BundleRunner}.
 */
export interface Runner {
  readonly name: string;
  run(options: RunOptions): Promise<void>;
}
