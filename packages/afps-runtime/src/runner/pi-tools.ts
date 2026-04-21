// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS platform tools as a Pi Coding Agent extension.
 *
 * Registers the five canonical AFPS tools (`add_memory`, `set_state`,
 * `output`, `report`, `log`) with the Pi agent. Each tool's `execute`
 * turns the tool invocation into the matching {@link AfpsEvent} and
 * publishes it through the caller-supplied emitter — no stdout parsing,
 * no subprocess, no JSON-line marshalling.
 *
 * The extension is isolated from Pi SDK internals via a minimal
 * structural type so it can be unit-tested with a fake `ExtensionAPI`
 * without pulling `@mariozechner/pi-coding-agent`.
 */

import type { AfpsEvent } from "../types/afps-event.ts";

export type AfpsEventEmitter = (event: AfpsEvent) => Promise<void>;

/**
 * Minimal shape of the Pi SDK `ExtensionAPI` we actually use. Pi's
 * real type is broader — we intentionally narrow here so the tool
 * factory is portable, typesafe at compile time, and mockable without
 * the SDK installed.
 */
export interface PiExtensionRegistrar {
  registerTool(config: PiToolConfig): unknown;
}

export interface PiToolConfig {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<PiToolExecuteResult>;
}

export interface PiToolExecuteResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
}

/**
 * Build a Pi extension that registers the five AFPS platform tools.
 *
 * `parametersFactory` is injected so this module stays free of a hard
 * dependency on `@mariozechner/pi-ai`'s `Type` builder — the production
 * PiRunner supplies the real builder, tests can pass a stub.
 */
export interface AfpsToolsOptions {
  emit: AfpsEventEmitter;
  parametersFactory: AfpsToolParameters;
}

/**
 * Parameter builder injected by the caller. The shapes here mirror
 * TypeBox (`Type.Object`, `Type.String`, `Type.Enum`, `Type.Any`) but
 * the factory accepts any compatible implementation.
 */
export interface AfpsToolParameters {
  addMemory: unknown;
  setState: unknown;
  output: unknown;
  report: unknown;
  log: unknown;
}

export function registerAfpsTools(pi: PiExtensionRegistrar, opts: AfpsToolsOptions): void {
  const { emit, parametersFactory } = opts;

  pi.registerTool({
    name: "add_memory",
    label: "Add Memory",
    description:
      "Save a durable memory — a discovery, fact, or user preference worth " +
      "keeping across future runs. Prefer bullet-sized entries (one fact per call).",
    parameters: parametersFactory.addMemory,
    execute: async (_id, params) => {
      const { content } = params as { content: string };
      await emit({ type: "add_memory", content });
      return { content: [{ type: "text", text: "Memory saved" }] };
    },
  });

  pi.registerTool({
    name: "set_state",
    label: "Set State",
    description:
      "Overwrite the agent's carry-over state for the next run. Last-write-wins; " +
      "the most recent call fully replaces any previous state.",
    parameters: parametersFactory.setState,
    execute: async (_id, params) => {
      const { state } = params as { state: unknown };
      await emit({ type: "set_state", state });
      return { content: [{ type: "text", text: "State updated" }] };
    },
  });

  pi.registerTool({
    name: "output",
    label: "Emit Output",
    description:
      "Emit a structured output value. Object fields are deep-merged with " +
      "prior output events (JSON merge-patch); arrays and scalars replace wholesale.",
    parameters: parametersFactory.output,
    execute: async (_id, params) => {
      const { data } = params as { data: unknown };
      await emit({ type: "output", data });
      return { content: [{ type: "text", text: "Output recorded" }] };
    },
  });

  pi.registerTool({
    name: "report",
    label: "Append Report",
    description:
      "Append a line to the human-readable run report. Lines are concatenated " +
      "with newline separators in the final RunResult.",
    parameters: parametersFactory.report,
    execute: async (_id, params) => {
      const { content } = params as { content: string };
      await emit({ type: "report", content });
      return { content: [{ type: "text", text: "Report line appended" }] };
    },
  });

  pi.registerTool({
    name: "log",
    label: "Log",
    description:
      "Emit a log entry with a severity level. Useful for observability — " +
      "logs surface in the final RunResult but are not part of the output deliverable.",
    parameters: parametersFactory.log,
    execute: async (_id, params) => {
      const { level, message } = params as { level: "info" | "warn" | "error"; message: string };
      await emit({ type: "log", level, message });
      return { content: [{ type: "text", text: "Logged" }] };
    },
  });
}
