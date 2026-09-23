// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Multiplexing MCP host.
 *
 * The sidecar exposes a single `/mcp` endpoint to the agent. Inside, we
 * aggregate tools from multiple MCP servers:
 *   - First-party (in-process): {ns}__api_call, run_history, recall_memory.
 *   - Third-party (subprocess via SubprocessTransport): notion-mcp,
 *     filesystem-mcp, etc.
 *
 * Every third-party tool is namespaced as `{namespace}__{tool}` to avoid
 * collisions and to stay within `MCP_TOOL_NAME_MAX_LENGTH` (56), which leaves
 * headroom under OpenAI/Anthropic's 64-char tool name regex for downstream
 * re-prefixing.
 *
 * What this module owns:
 *   - The {@link McpHost} class — registry of upstream MCP clients plus
 *     a snapshot of their advertised tools.
 *   - The {@link buildMultiplexedTools} function — produces a flat
 *     `AppstrateToolDefinition[]` ready for `createMcpServer`.
 *   - The `notifications/message` → CloudEvents transducer hook.
 *
 * What it deliberately does NOT own:
 *   - Spawning subprocesses (orchestrator owns lifecycle).
 *   - Trust-isolation primitives — UID, namespaces, seccomp, cgroups.
 *     Deployment-side; this module just consumes the already-isolated
 *     SubprocessTransport.
 */

import {
  allocateMcpToolNamespace,
  isValidToolName,
  normaliseMcpToolBody,
  normaliseMcpToolNamespace,
} from "@appstrate/core/naming";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import { RUNTIME_TOOL_EVENTS_META_KEY } from "@appstrate/core/runtime-tool-defs";
import {
  sanitiseTextField,
  sanitiseToolDescriptor,
  type AppstrateMcpClient,
  type AppstrateToolDefinition,
  type CallToolResult,
  type Tool,
} from "@appstrate/mcp-transport";

/**
 * Drop the first-party runtime-event channel from a third-party tool result.
 * `dev.appstrate/events` under `_meta` is the trusted channel the platform's
 * own runtime tools (output/log/note/pin) use to surface canonical run
 * events; an integration upstream has no legitimate reason to set it, so we
 * remove it to prevent run-event forgery. Returns the result untouched when
 * the key is not present (the common case).
 */
function stripForgedRuntimeEvents(result: CallToolResult): CallToolResult {
  const meta = result._meta;
  if (!meta || !(RUNTIME_TOOL_EVENTS_META_KEY in meta)) {
    return result;
  }
  const { [RUNTIME_TOOL_EVENTS_META_KEY]: _dropped, ...rest } = meta;
  return { ...result, _meta: rest };
}

interface McpHostUpstream {
  /** Stable identifier for this upstream — appears in tool name prefix. */
  namespace: string;
  /** Connected client (any transport). */
  client: AppstrateMcpClient;
  /** The bound connection this upstream serves; its label is the selector value. */
  connection?: { label: string; accountId: string | null };
  /**
   * Niveau 2 Phase 3 — agent-declared MCP tool allowlist. When set, only
   * tools whose ORIGINAL name (as advertised by the upstream's
   * `tools/list`) appears here are registered with the host; excluded
   * tools are silently dropped (with an audit log) so the agent's LLM
   * never sees a tool it isn't authorised to call.
   *
   * `undefined` (default) preserves the legacy "all tools allowed"
   * behaviour. Empty `[]` is a valid explicit "register nothing".
   */
  allowedTools?: readonly string[];
  /**
   * R8a defensive filter — names from the integration manifest's
   * `hidden_tools` field. Applied AFTER `allowedTools`: a tool that
   * survives the allowlist is still dropped if it appears here. This
   * mirrors the install-time `resolveIntegrationToolCatalog` policy
   * (which already excludes hidden tools from the agent's selection),
   * adding a runtime-side guarantee that the same names can never reach
   * the agent even when fixtures / direct DB writes bypass install-time
   * validation. `undefined` / empty = no extra filtering.
   */
  hiddenTools?: readonly string[];
  /**
   * Trusted first-party upstream (e.g. the sidecar's own in-process
   * `api_call` server). Skips the tool-poisoning sanitiser
   * (`sanitiseToolDescriptor`) — which is designed for UNTRUSTED
   * third-party MCP servers and caps every `description` to 512 bytes /
   * the whole schema to 8 KB. Our first-party tools ship deliberately
   * rich, audited documentation (the `api_call` body / multipart docs the
   * agent needs to format requests) that must survive intact. Namespacing
   * + tool-name validation still apply.
   */
  trusted?: boolean;
  /**
   * Register this upstream's tools UNDER an existing namespace instead of
   * allocating a fresh (possibly suffixed) one. Used to attach the in-process
   * `api_call` tool to an integration that ALSO spawns its own MCP server, so
   * the agent sees `{ns}__api_call` alongside `{ns}__<native tools>` under one
   * namespace. These merged tools route to THIS client via the per-tool index.
   * The namespace must already exist (register the server first).
   */
  intoNamespace?: string;
}

interface McpHostOptions {
  /** Sink for `notifications/message` from third-party servers. */
  onLog?: (event: { source: string; level: string; data: unknown }) => void;
}

/** Reserved: an upstream that declares it cannot be served by N connections. */
const CONNECTION_PARAM = "connection";

const CONNECTION_DESCRIPTION_PREFIX = "Connection to use for this call. ";
/** 80 UTF-16 units (the platform's label cap), each at most 3 UTF-8 bytes. */
const CONNECTION_LABEL_MAX_BYTES = 80 * 3;
/** An email address. A longer account id truncates the description's tail, never an enum value. */
const CONNECTION_ACCOUNT_ID_MAX_BYTES = 254;
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;
const CONNECTION_DESCRIPTION_MAX_BYTES =
  utf8Bytes(CONNECTION_DESCRIPTION_PREFIX) +
  MAX_CONNECTIONS_PER_INTEGRATION *
    (CONNECTION_LABEL_MAX_BYTES +
      utf8Bytes(" → ") +
      CONNECTION_ACCOUNT_ID_MAX_BYTES +
      utf8Bytes("; "));

/** `null` keys only a connect run's sole upstream, which never gains a sibling route. */
type ConnectionKey = string | null;

interface ToolRoute {
  client: AppstrateMcpClient;
  accountId: string | null;
  originalName: string;
}

function siblingKey(trusted: boolean, originalName: string): string {
  return `${trusted ? "t" : "u"}:${originalName}`;
}

function declaresConnectionParam(descriptor: Tool | undefined): boolean {
  const schema = descriptor?.inputSchema as { properties?: Record<string, unknown> } | undefined;
  const properties = schema?.properties;
  return properties !== undefined && Object.hasOwn(properties, CONNECTION_PARAM);
}

function withConnectionParam(descriptor: Tool, routes: Map<ConnectionKey, ToolRoute>): Tool {
  const labels = routeLabels(routes);
  const schema = descriptor.inputSchema as unknown as Record<string, unknown>;
  const properties = { ...((schema.properties as Record<string, unknown> | undefined) ?? {}) };
  properties[CONNECTION_PARAM] = {
    type: "string",
    // Enum values stay VERBATIM — they are the keys `callTool` looks up, so
    // sanitising them would make a routable connection unselectable. The prose
    // is the injection surface: `label` is member-editable and `accountId`
    // provider-supplied, so the description goes through the text sanitiser.
    enum: labels,
    description: sanitiseTextField(
      `${CONNECTION_DESCRIPTION_PREFIX}${labels
        .map((label) => `${label} → ${routes.get(label)!.accountId ?? "no account id"}`)
        .join("; ")}`,
      CONNECTION_DESCRIPTION_MAX_BYTES,
    ),
  };
  const required = Array.isArray(schema.required) ? [...(schema.required as string[])] : [];
  required.push(CONNECTION_PARAM);
  return {
    ...descriptor,
    inputSchema: { ...schema, type: "object", properties, required } as Tool["inputSchema"],
  };
}

function routeLabels(routes: Map<ConnectionKey, ToolRoute>): string[] {
  return [...routes.keys()].filter((key): key is string => key !== null);
}

function connectionSelectionError(
  toolName: string,
  received: unknown,
  labels: readonly string[],
): CallToolResult {
  const suffix =
    received === undefined
      ? ""
      : ` Received ${JSON.stringify(received)}, which is not one of them.`;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Tool "${toolName}" is served by ${labels.length} connections. Set "${CONNECTION_PARAM}" to one of: ${labels.join(", ")}.${suffix}`,
      },
    ],
  };
}

/**
 * Multiplexing host — aggregates tools from N upstream MCP clients.
 *
 * Lifecycle:
 *   1. `register({ namespace, client, connection })` — ingest one upstream.
 *      Calls `listTools()` on the client and snapshots the descriptors.
 *   2. Tool dispatch: `tools/call` routes by (tool name, connection label);
 *      see {@link withConnectionParam} for the selector a shared name gets.
 *   3. `dispose()` — closes every client. Idempotent.
 *
 * The host renames each upstream tool to `{namespace}__{name}` and
 * applies tool-poisoning sanitisation (length caps + hidden-Unicode
 * stripping) before advertising it to the agent. Descriptors that
 * exceed the schema-size cap after sanitisation are rejected.
 */
export class McpHost {
  // No namespace → client map: one namespace holds several connections' clients.
  private readonly namespaces = new Set<string>();
  // Requested (raw) namespace → its allocated slot + the labels already there.
  // Keyed on the RAW id so another connection of the same integration reuses
  // the slot, while two different packages sharing a slug still get `_2`.
  private readonly namespaceSlots = new Map<string, { slot: string; labels: Set<ConnectionKey> }>();
  private readonly toolToNamespace = new Map<string, string>();
  // Per-tool → per-connection-label → owning client.
  private readonly toolRoutes = new Map<string, Map<ConnectionKey, ToolRoute>>();
  // Slot → (trust, ORIGINAL upstream name) → final name, so a later connection
  // lands on the name the first one got, fallback and suffix included.
  private readonly siblingNames = new Map<string, Map<string, string>>();
  // Trust provenance for collision handling. A trusted first-party descriptor
  // canonically replaces a same-named untrusted descriptor; trusted/trusted
  // collisions remain fatal because they indicate a platform contract bug.
  private readonly toolTrusted = new Map<string, boolean>();
  // Every distinct client registered, primary or merged — closed on dispose.
  private readonly clients = new Set<AppstrateMcpClient>();
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
  /**
   * Ingest an upstream MCP server. Returns the ALLOCATED namespace — the
   * normalised slug, possibly disambiguated with a `_2`/`_3`/… suffix on
   * collision — the `{namespace}__` prefix of every tool it advertises.
   */
  async register(upstream: McpHostUpstream): Promise<string> {
    if (this.disposed) throw new Error("McpHost: cannot register after dispose()");
    const baseNamespace = normaliseNamespace(upstream.namespace);
    if (!baseNamespace) {
      throw new Error(`McpHost: namespace '${upstream.namespace}' is empty after normalisation`);
    }
    // Per integrations spec §5.4.5: collision between two integrations
    // sharing the same last-segment slug (e.g. `@official/gmail` vs
    // `@vendor/gmail`) → auto-suffix `_2`, `_3`, … with an audit log,
    // instead of throwing. Throwing would let one badly-named package
    // gate every install of any other package sharing its slug.
    // `intoNamespace` merges into an existing namespace (no allocation, no
    // suffix); otherwise allocate a fresh slot, disambiguating on collision.
    const merging = upstream.intoNamespace !== undefined;
    if (merging && !this.namespaces.has(upstream.intoNamespace!)) {
      throw new Error(
        `McpHost: intoNamespace '${upstream.intoNamespace}' is not a registered namespace`,
      );
    }
    const label: ConnectionKey = upstream.connection?.label ?? null;
    const slot = this.namespaceSlots.get(upstream.namespace);
    // Invariant: a duplicate label would leave one connection unaddressable.
    if (!merging && slot?.labels.has(label)) {
      throw new Error(
        `McpHost: duplicate connection ${JSON.stringify(label)} for ${JSON.stringify(upstream.namespace)} — two spawn specs of one integration cannot share a label`,
      );
    }
    const reusedSlot = !merging && slot !== undefined;
    const normalisedNs = merging
      ? upstream.intoNamespace!
      : reusedSlot
        ? slot!.slot
        : this.allocateNamespace(baseNamespace);
    if (!merging) {
      if (reusedSlot) slot!.labels.add(label);
      else {
        this.namespaceSlots.set(upstream.namespace, {
          slot: normalisedNs,
          labels: new Set([label]),
        });
      }
    }
    const effectiveUpstream: McpHostUpstream = { ...upstream, namespace: normalisedNs };
    this.clients.add(effectiveUpstream.client);
    if (!merging && !reusedSlot && normalisedNs !== baseNamespace) {
      this.options.onLog?.({
        source: `host:${normalisedNs}`,
        level: "warn",
        data: {
          event: "namespace_disambiguated",
          requestedNamespace: upstream.namespace,
          base: baseNamespace,
          allocated: normalisedNs,
        },
      });
    }

    // Capture the upstream's MCP `initialize` snapshot so operator
    // dashboards can audit which third-party server version is actually
    // wired (versions on disk drift from versions on the wire), and so
    // we can skip `tools/list` against a server that didn't advertise
    // the `tools` capability — JSON-RPC error round-trips on every
    // register would otherwise add a per-server failure mode.
    const serverVersion = effectiveUpstream.client.getServerVersion();
    const capabilities = effectiveUpstream.client.getServerCapabilities();
    this.options.onLog?.({
      source: `host:${normalisedNs}`,
      level: "info",
      data: {
        event: "upstream_registered",
        serverInfo: serverVersion ?? null,
        capabilities: capabilities ?? null,
      },
    });

    if (capabilities && !capabilities.tools) {
      // Server explicitly does NOT support tools — no point asking.
      this.namespaces.add(normalisedNs);
      return normalisedNs;
    }

    const { tools } = await effectiveUpstream.client.listTools();
    // Niveau 2 Phase 3 — pre-filter against the agent-declared allowlist
    // before any sanitisation / registration. The check uses the
    // ORIGINAL upstream tool name; namespacing happens downstream and
    // wouldn't survive a Set lookup against the agent's declared names.
    const allowlist = upstream.allowedTools ? new Set<string>(upstream.allowedTools) : null;
    // R8a defensive filter — `hidden_tools` exclusion runs AFTER the
    // allowlist (a tool that survives the allowlist can still be hidden).
    // Empty set = no extra exclusion. Original-name matching, same as
    // the allowlist, so authors declare names exactly as the upstream
    // advertises them.
    const hiddenSet = upstream.hiddenTools ? new Set<string>(upstream.hiddenTools) : null;
    // Trusted descriptors participate in a platform/catalog contract. Validate
    // their complete surface atomically before mutating any tool index: a
    // fallback or collision suffix would create a runtime-only name, while a
    // late throw after registering an earlier sibling would leak a partial
    // capability from an integration whose boot is reported failed.
    const trustedReplacements = new Set<string>();
    if (upstream.trusted) {
      const incomingNames = new Set<string>();
      for (const tool of tools) {
        if (allowlist && !allowlist.has(tool.name)) continue;
        if (hiddenSet && hiddenSet.has(tool.name)) continue;
        const candidate = `${normalisedNs}__${tool.name}`;
        if (!isValidToolName(candidate)) {
          throw new Error(
            `McpHost: trusted tool ${JSON.stringify(tool.name)} produces invalid namespaced name ${JSON.stringify(candidate)}`,
          );
        }
        if (incomingNames.has(candidate)) {
          throw new Error(`McpHost: trusted tool name collision on ${JSON.stringify(candidate)}`);
        }
        incomingNames.add(candidate);
        if (this.siblingName(normalisedNs, true, tool.name, label) !== undefined) continue;
        if (this.toolToNamespace.has(candidate)) {
          if (this.toolTrusted.get(candidate) === false) {
            trustedReplacements.add(candidate);
          } else {
            throw new Error(`McpHost: trusted tool name collision on ${JSON.stringify(candidate)}`);
          }
        }
      }
      for (const name of trustedReplacements) {
        const index = this.toolDescriptors.findIndex((descriptor) => descriptor.name === name);
        if (index >= 0) this.toolDescriptors.splice(index, 1);
        this.toolToNamespace.delete(name);
        this.toolRoutes.delete(name);
        this.toolTrusted.delete(name);
        const siblings = this.siblingNames.get(normalisedNs);
        for (const [key, finalName] of siblings ?? []) {
          if (finalName === name) siblings!.delete(key);
        }
        this.options.onLog?.({
          source: `host:${normalisedNs}`,
          level: "warn",
          data: { event: "untrusted_tool_replaced_by_trusted", name },
        });
      }
    }
    for (const tool of tools) {
      if (allowlist && !allowlist.has(tool.name)) {
        this.options.onLog?.({
          source: `host:${normalisedNs}`,
          level: "info",
          data: {
            event: "tool_excluded_by_allowlist",
            originalName: tool.name,
          },
        });
        continue;
      }
      if (hiddenSet && hiddenSet.has(tool.name)) {
        this.options.onLog?.({
          source: `host:${normalisedNs}`,
          level: "info",
          data: {
            event: "tool_excluded_by_hidden_tools",
            originalName: tool.name,
          },
        });
        continue;
      }
      // Strip hidden Unicode, cap field lengths, defeat tool poisoning
      // before any third-party descriptor reaches
      // the agent's LLM. A descriptor that exceeds the schema-size cap
      // after sanitisation is dropped entirely; the host emits a log
      // event so operators can audit the rejection. Trusted first-party
      // upstreams (our own in-process api_call server) bypass the
      // sanitiser so their rich audited docs survive intact.
      const sanitised = upstream.trusted ? tool : sanitiseToolDescriptor(tool);
      if (!sanitised) {
        this.options.onLog?.({
          source: `host:${normalisedNs}`,
          level: "warn",
          data: {
            event: "tool_rejected",
            reason: "schema_too_large_after_sanitisation",
            originalName: tool.name,
          },
        });
        continue;
      }
      const sibling = this.siblingName(normalisedNs, upstream.trusted === true, tool.name, label);
      if (sibling !== undefined) {
        this.addRoute(sibling, effectiveUpstream, sanitised, tool.name, normalisedNs);
        continue;
      }
      // Trusted first-party tools are already emitted in the canonical body
      // form. Preserve it verbatim so auth-scoped synthetic names such as
      // `api_call__primary` keep their auth-scoped token suffix. The third-party
      // sanitiser deliberately treats the first `__` as an upstream namespace
      // and strips it; applying that rule here would collapse the trusted name
      // to `primary`, making the runtime surface diverge from the catalog.
      // `isValidToolName` below still validates the fully namespaced result;
      // malformed trusted descriptors fail loudly because an opaque fallback
      // would diverge from the platform catalog. Both halves are platform-
      // produced — the namespace normalises any AFPS-valid package id
      // (including digit-leading scopes like `@1password`) and the body is
      // emitted by `createApiCallToolDefs` within the shared length budget —
      // so this throw is unreachable for any manifest the platform accepts;
      // it guards future emitters, not user input. Untrusted names retain
      // the defensive fallback below.
      const sanitisedToolBody = upstream.trusted
        ? sanitised.name
        : normaliseMcpToolBody(sanitised.name);
      const namespacedName = sanitisedToolBody ? `${normalisedNs}__${sanitisedToolBody}` : "";
      if (upstream.trusted && !isValidToolName(namespacedName)) {
        throw new Error(
          `McpHost: trusted tool ${JSON.stringify(sanitised.name)} produces invalid namespaced name ${JSON.stringify(namespacedName)}`,
        );
      }
      let finalName = isValidToolName(namespacedName)
        ? namespacedName
        : `${normalisedNs}__tool_${this.toolDescriptors.length}`;
      // Dedup: two DISTINCT upstream tools can converge onto the same
      // `finalName` after `normaliseMcpToolBody` collapses separators (e.g.
      // `list-issues`, `list_issues`, and `list.issues` all → `list_issues`).
      // Without this guard the later tool would silently overwrite the
      // earlier one's `toolRoutes` entry while both still get pushed onto
      // `toolDescriptors` — the agent would see a duplicate name and the
      // first tool would become unreachable. Suffix `_2`, `_3`, … until free,
      // mirroring namespace disambiguation.
      if (this.toolToNamespace.has(finalName)) {
        // Trusted platform capabilities always own their canonical name,
        // independent of registration order. When an untrusted upstream is
        // registered after the synthetic tool, drop the colliding descriptor
        // instead of inventing a suffixed capability that was never present in
        // the integration catalog. The reverse order is handled atomically by
        // `trustedReplacements` above.
        if (!upstream.trusted && this.toolTrusted.get(finalName) === true) {
          this.options.onLog?.({
            source: `host:${normalisedNs}`,
            level: "warn",
            data: {
              event: "untrusted_tool_shadowed_by_trusted",
              originalName: tool.name,
              name: finalName,
            },
          });
          continue;
        }
        const base = finalName;
        let suffix = 2;
        while (this.toolToNamespace.has(finalName)) {
          finalName = `${base}_${suffix}`;
          suffix += 1;
        }
        this.options.onLog?.({
          source: `host:${normalisedNs}`,
          level: "warn",
          data: {
            event: "tool_name_collision",
            originalName: tool.name,
            base,
            allocated: finalName,
          },
        });
      }
      this.toolToNamespace.set(finalName, normalisedNs);
      this.toolRoutes.set(
        finalName,
        new Map([[label, this.routeFor(effectiveUpstream, tool.name)]]),
      );
      this.toolTrusted.set(finalName, upstream.trusted === true);
      this.toolDescriptors.push({ ...sanitised, name: finalName });
      const siblings = this.siblingNames.get(normalisedNs) ?? new Map<string, string>();
      this.siblingNames.set(normalisedNs, siblings);
      const key = siblingKey(upstream.trusted === true, tool.name);
      if (!siblings.has(key)) siblings.set(key, finalName);
    }

    this.namespaces.add(normalisedNs);
    return normalisedNs;
  }

  private routeFor(upstream: McpHostUpstream, originalName: string): ToolRoute {
    return {
      client: upstream.client,
      accountId: upstream.connection?.accountId ?? null,
      originalName,
    };
  }

  /** The name another connection of this slot gave `originalName`, when this label can join it. */
  private siblingName(
    slot: string,
    trusted: boolean,
    originalName: string,
    label: ConnectionKey,
  ): string | undefined {
    const name = this.siblingNames.get(slot)?.get(siblingKey(trusted, originalName));
    return name !== undefined && !this.toolRoutes.get(name)!.has(label) ? name : undefined;
  }

  private addRoute(
    name: string,
    upstream: McpHostUpstream,
    incoming: Tool,
    originalName: string,
    namespace: string,
  ): void {
    const routes = this.toolRoutes.get(name)!;
    const label: ConnectionKey = upstream.connection?.label ?? null;
    const served = this.toolDescriptors.find((d) => d.name === name);
    if (declaresConnectionParam(served) || declaresConnectionParam(incoming)) {
      throw new Error(
        `McpHost: connection_param_conflict — tool ${JSON.stringify(name)} already declares a "${CONNECTION_PARAM}" property, so the per-connection selector cannot be injected`,
      );
    }
    routes.set(label, this.routeFor(upstream, originalName));
    this.options.onLog?.({
      source: `host:${namespace}`,
      level: "info",
      data: { event: "tool_connection_route_added", name, connection: label },
    });
  }

  /**
   * Find a free namespace slot. The base slug is tried first; if it is
   * already in use we suffix `_2`, `_3`, … until we find an unused slot.
   * The chosen slot is what every subsequent index ({@link toolToNamespace},
   * {@link namespaces}) keys against.
   */
  private allocateNamespace(base: string): string {
    return allocateMcpToolNamespace(base, this.namespaces);
  }

  /** Routes, not descriptors: a second connection adds no descriptor but is not zero tools. */
  routeCount(): number {
    let total = 0;
    for (const routes of this.toolRoutes.values()) total += routes.size;
    return total;
  }

  /**
   * Build {@link AppstrateToolDefinition}s — a flat list ready for
   * `createMcpServer(...)`. The handler dispatches `tools/call` to the
   * upstream client identified by the prefix.
   *
   * Optional `inject` parameter merges first-party tools ({ns}__api_call,
   * run_history, recall_memory) into the same flat list. The host does
   * not validate name collisions between first-party and third-party
   * tools — first-party names take precedence.
   */
  buildTools(inject: AppstrateToolDefinition[] = []): AppstrateToolDefinition[] {
    const firstPartyNames = new Set(inject.map((t) => t.descriptor.name));
    const thirdParty: AppstrateToolDefinition[] = [];
    for (const desc of this.toolDescriptors) {
      if (firstPartyNames.has(desc.name)) continue;
      const routes = this.toolRoutes.get(desc.name);
      if (!routes || routes.size === 0) continue;
      const forward = async (
        route: ToolRoute,
        args: Record<string, unknown>,
        extra: { signal?: AbortSignal },
      ): Promise<CallToolResult> =>
        stripForgedRuntimeEvents(
          await route.client.callTool(
            { name: route.originalName, arguments: args },
            { ...(extra.signal ? { signal: extra.signal } : {}) },
          ),
        );
      if (routes.size === 1) {
        const [sole] = [...routes.values()];
        thirdParty.push({
          descriptor: desc,
          handler: async (args, extra) => forward(sole!, args, extra),
        });
        continue;
      }
      const labels = routeLabels(routes);
      thirdParty.push({
        descriptor: withConnectionParam(desc, routes),
        handler: async (args, extra): Promise<CallToolResult> => {
          const { [CONNECTION_PARAM]: selected, ...rest } = args;
          const route = typeof selected === "string" ? routes.get(selected) : undefined;
          if (!route) return connectionSelectionError(desc.name, selected, labels);
          return forward(route, rest, extra);
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
      [...this.clients].map((c) =>
        c.close().catch(() => {
          // Swallow close errors — we're tearing down; the caller
          // already learned the run is over.
        }),
      ),
    );
    this.namespaces.clear();
    this.namespaceSlots.clear();
    this.toolToNamespace.clear();
    this.toolRoutes.clear();
    this.siblingNames.clear();
    this.toolTrusted.clear();
    this.clients.clear();
    this.toolDescriptors.length = 0;
  }
}

/**
 * Normalise an upstream namespace into the snake_case form expected by
 * the V3 tool-name regex. Returns `""` when the input is empty or
 * contains nothing usable.
 */
export function normaliseNamespace(raw: string): string {
  return normaliseMcpToolNamespace(raw);
}
