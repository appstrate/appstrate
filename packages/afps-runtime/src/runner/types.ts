// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS run invocation surface.
 *
 * {@link RunOptions} is what a runner is handed: a loaded bundle, the
 * per-run execution context, the {@link EventSink} that receives every
 * RunEvent the tools emit, and a cancellation token. Tools come from
 * spawned `mcp-server` packages and integrations; credentialled HTTP
 * (integration `api_call`) is wired by the runner implementation as
 * pre-built tools, not via a generic in-process resolver.
 *
 * Specification: `afps-spec/spec.md` §8, spec document §5.
 */

import type { EventSink } from "../interfaces/event-sink.ts";
import type { Bundle } from "../bundle/types.ts";
import type { ExecutionContext } from "../types/execution-context.ts";

export interface RunOptions {
  /** Already-loaded {@link Bundle} (root package + transitively resolved deps). */
  bundle: Bundle;
  /** Per-run execution context — runId, input, template vars. */
  context: ExecutionContext;

  /** Business terminus — receives every RunEvent the tools emit. */
  eventSink: EventSink;

  /** Cancellation token. Runner MUST stop emitting and reject if aborted. */
  signal?: AbortSignal;
}
