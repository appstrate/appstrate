// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Multiplexing MCP host (Phase 4 of #276, §D4.3).
 *
 * The sidecar exposes a single `/mcp` endpoint to the agent. Inside,
 * we aggregate tools from multiple MCP servers:
 *   - First-party (in-process): provider_call, run_history, llm_complete.
 *   - Third-party (subprocess via SubprocessTransport): notion-mcp,
 *     filesystem-mcp, etc.
 *
 * Every third-party tool is namespaced as `{namespace}__{tool}` per V3
 * to avoid collisions and to satisfy OpenAI/Anthropic's 64-char tool
 * name regex with headroom for downstream re-prefixing.
 *
 * What this module owns:
 *   - The {@link McpHost} class — registry of upstream MCP clients +
 *     a snapshot of their advertised tools.
 *   - The {@link buildMultiplexedTools} function — produces a flat
 *     `AppstrateToolDefinition[]` ready for `createMcpServer`.
 *   - The notifications/message → CloudEvents transducer hook (§D4.5).
 *
 * What it deliberately does NOT own:
 *   - Spawning subprocesses. That's the orchestrator (it owns lifecycle
 *     across the run).
 *   - Trust isolation primitives — UID, namespaces, seccomp,
 *     cgroups. Deployment-side; this module just consumes the already-
 *     isolated SubprocessTransport.
 *   - Tool-description sanitisation against Tool Poisoning attacks —
 *     belongs in the multiplexer's tool-list reducer (added separately
 *     when registry-side validation lands per V13).
 */

import { isValidToolNameForExisting } from "@appstrate/core/naming";
import {
  sanitiseToolDescriptor,
  type AppstrateMcpClient,
  type AppstrateToolDefinition,
  type CallToolResult,
  type Tool,
} from "@appstrate/mcp-transport";

export interface McpHostUpstream {
  /** Stable identifier for this upstream — appears in tool name prefix. */
  namespace: string;
  /** Connected client (any transport). */
  client: AppstrateMcpClient;
}

export interface McpHostOptions {
  /** Sink for `notifications/message` from third-party servers (D4.5). */
  onLog?: (event: { source: string; level: string; data: unknown }) => void;
}

/**
 * Multiplexing host — aggregates tools from N upstream MCP clients.
 *
 * Lifecycle:
 *   1. `register({ namespace, client })` — ingest an upstream MCP server.
 *      Calls `listTools()` on the client and snapshots the descriptors.
 *   2. Tool dispatch: `tools/call` on the host's outward face routes to
 *      the right upstream by stripping the `{namespace}__` prefix.
 *   3. `dispose()` — closes every client. Idempotent.
 *
 * The host does NOT mutate the upstream descriptors beyond renaming —
 * descriptions, schemas, and annotations pass through verbatim. Tool
 * Poisoning hardening (length caps, hidden Unicode stripping) is a
 * registry-side concern per the migration plan §V13.
 */
export class McpHost {
  private readonly upstreams = new Map<string, McpHostUpstream>();
  private readonly toolToNamespace = new Map<string, string>();
  private readonly originalToolNames = new Map<string, string>();
  private readonly toolDescriptors: Tool[] = [];
  private readonly options: McpHostOptions;
  private disposed = false;

  constructor(options: McpHostOptions = {}) {
    this.options = options;
  }

  /**
   * Register an upstream MCP server. Snapshots its `tools/list` once;
   * subsequent server-side `notifications/tools/list_changed` are NOT
   * tracked yet (third-party MCP servers rarely emit them in practice).
   */
  async register(upstream: McpHostUpstream): Promise<void> {
    if (this.disposed) throw new Error("McpHost: cannot register after dispose()");
    if (this.upstreams.has(upstream.namespace)) {
      throw new Error(`McpHost: namespace '${upstream.namespace}' already registered`);
    }
    const normalisedNs = normaliseNamespace(upstream.namespace);
    if (!normalisedNs) {
      throw new Error(`McpHost: namespace '${upstream.namespace}' is empty after normalisation`);
    }

    const { tools } = await upstream.client.listTools();
    for (const tool of tools) {
      // Phase 5 of #276 — strip hidden Unicode, cap field lengths,
      // defeat tool poisoning before any third-party descriptor reaches
      // the agent's LLM. A descriptor that exceeds the schema-size cap
      // after sanitisation is dropped entirely; the host emits a log
      // event so operators can audit the rejection.
      const sanitised = sanitiseToolDescriptor(tool);
      if (!sanitised) {
        this.options.onLog?.({
          source: `host:${upstream.namespace}`,
          level: "warn",
          data: {
            event: "tool_rejected",
            reason: "schema_too_large_after_sanitisation",
            originalName: tool.name,
          },
        });
        continue;
      }
      const sanitisedToolBody = sanitiseToolBody(sanitised.name);
      const namespacedName = sanitisedToolBody ? `${normalisedNs}__${sanitisedToolBody}` : "";
      const finalName = isValidToolNameForExisting(namespacedName)
        ? namespacedName
        : `${normalisedNs}__tool_${this.toolDescriptors.length}`;
      this.toolToNamespace.set(finalName, upstream.namespace);
      this.originalToolNames.set(finalName, tool.name);
      this.toolDescriptors.push({ ...sanitised, name: finalName });
    }

    this.upstreams.set(upstream.namespace, upstream);
  }

  /** Total number of upstream-advertised tools currently known. */
  size(): number {
    return this.toolDescriptors.length;
  }

  /**
   * Build {@link AppstrateToolDefinition}s — a flat list ready for
   * `createMcpServer(...)`. The handler dispatches `tools/call` to the
   * upstream client identified by the prefix.
   *
   * Optional `inject` parameter merges first-party tools (provider_call,
   * run_history, llm_complete) into the same flat list. The host does
   * not validate name collisions between first-party and third-party
   * tools — first-party names take precedence.
   */
  buildTools(inject: AppstrateToolDefinition[] = []): AppstrateToolDefinition[] {
    const firstPartyNames = new Set(inject.map((t) => t.descriptor.name));
    const thirdParty: AppstrateToolDefinition[] = [];
    for (const desc of this.toolDescriptors) {
      if (firstPartyNames.has(desc.name)) continue;
      const namespace = this.toolToNamespace.get(desc.name)!;
      const originalName = this.originalToolNames.get(desc.name)!;
      const upstream = this.upstreams.get(namespace);
      if (!upstream) continue;
      thirdParty.push({
        descriptor: desc,
        handler: async (args, extra): Promise<CallToolResult> => {
          // Forward to upstream with the original (un-namespaced) name.
          // Cancellation via the SDK's RequestHandlerExtra signal.
          return upstream.client.callTool(
            { name: originalName, arguments: args },
            { ...(extra.signal ? { signal: extra.signal } : {}) },
          );
        },
      });
    }
    return [...inject, ...thirdParty];
  }

  /**
   * Forward a `notifications/message` from a third-party MCP server to
   * the configured log sink (D4.5 transducer). The host does not
   * subscribe to upstream notifications itself — wire this up at the
   * orchestrator that owns each subprocess.
   */
  emitLog(source: string, level: string, data: unknown): void {
    this.options.onLog?.({ source, level, data });
  }

  /** Close every upstream. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all(
      [...this.upstreams.values()].map((u) =>
        u.client.close().catch(() => {
          // Swallow close errors — we're tearing down; the caller
          // already learned the run is over.
        }),
      ),
    );
    this.upstreams.clear();
    this.toolToNamespace.clear();
    this.originalToolNames.clear();
    this.toolDescriptors.length = 0;
  }
}

/**
 * Normalise an upstream namespace into the snake_case form expected by
 * the V3 tool-name regex. Returns `""` when the input is empty or
 * contains nothing usable.
 */
function normaliseNamespace(raw: string): string {
  if (typeof raw !== "string") return "";
  const out = raw
    .replace(/^@/, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return out.slice(0, 20);
}

/**
 * Sanitise a third-party tool name into the snake_case body expected
 * after the `{ns}__` prefix. Strips any leading namespace the upstream
 * may have added itself (so re-namespacing doesn't double up), keeps
 * `_` separators intact.
 */
function sanitiseToolBody(raw: string): string {
  if (typeof raw !== "string") return "";
  let out = raw
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  // If the upstream already namespaced (e.g. `fs__read_file`), drop the
  // upstream's prefix so the host's prefix doesn't double up.
  const idx = out.indexOf("__");
  if (idx >= 0 && idx < out.length - 2) {
    out = out.slice(idx + 2);
  }
  return out;
}
