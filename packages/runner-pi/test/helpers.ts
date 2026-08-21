// SPDX-License-Identifier: Apache-2.0

/**
 * Test helpers for PiRunner unit tests. Centralises the small
 * primitives (mock session, capture sink, test subclass) so every
 * test file reads the same way.
 */

import type {
  BridgeableSession,
  InternalSink,
  PromptableSession,
  SessionBridgeHandle,
  ToolWideningSession,
} from "../src/pi-runner.ts";
import { PiRunner } from "../src/pi-runner.ts";
import type { EventSink } from "@appstrate/afps-runtime/interfaces";
import type { RunEvent, ExecutionContext } from "@appstrate/afps-runtime/types";
import type { RunResult } from "@appstrate/afps-runtime/runner";
import {
  BUNDLE_FORMAT_VERSION,
  bundleIntegrity,
  computeRecordEntries,
  recordIntegrity,
  serializeRecord,
  type Bundle,
  type BundlePackage,
  type PackageIdentity,
} from "@appstrate/afps-runtime/bundle";

/** Fake Pi SDK session with driver methods the tests can invoke directly. */
export interface FakeSession extends BridgeableSession, PromptableSession, ToolWideningSession {
  /** Drive a raw Pi SDK event onto the bridge. */
  emit(event: unknown): void;
  /** Append a message to `state.messages` (used by message_end handler). */
  pushMessage(msg: unknown): void;
  /** Clear all listeners — lets tests assert "no leaks after run". */
  reset(): void;
  /** Every message passed to `prompt()`, in order. */
  prompts: string[];
  /** Times the bridge's early-stop `onTerminalTool` fired (stands in for `session.abort()`). */
  aborts: number;
  /** Test hook: drives what the session does during a `prompt()` turn. */
  onPrompt?: (message: string) => void | Promise<void>;
  /** Every `setActiveToolsByName()` argument, in order (raw, pre-resolution). */
  setActiveToolsCalls: string[][];
  /**
   * Ordered trace of the two calls that must happen in sequence — a
   * `"set_active_tools"` entry followed by `"prompt"` proves the tool set was
   * narrowed BEFORE the corrective turn went out.
   */
  callLog: Array<"set_active_tools" | "prompt">;
  /** Tools the agent may call on the next turn, after registry resolution. */
  activeTools: string[];
  /** Active tool names snapshotted at each `prompt()` call, in order. */
  activeToolsAtPrompt: string[][];
}

/**
 * @param opts.toolRegistry names the SDK tool registry resolves. Mirrors
 *   production: the four Pi built-ins plus the `output` runtime tool that
 *   `runtime-pi/mcp/direct.ts` registers verbatim under `tool.name`. Drop
 *   `"output"` (or `"read"`) from it to reproduce the defended cases where a
 *   name the corrective turn asks for is one the SDK never resolved.
 * @param opts.activeTools names active BEFORE the test acts, defaulting to the
 *   whole registry. Production is narrower — `createAgentSession` activates
 *   four of the seven Pi built-ins — so pass this to reproduce a registry that
 *   knows more tools than the session has switched on.
 */
export function createFakeSession(
  opts: { toolRegistry?: string[]; activeTools?: string[] } = {},
): FakeSession {
  const listeners: Array<(event: unknown) => void> = [];
  const messages: unknown[] = [];
  const toolRegistry = new Set(opts.toolRegistry ?? ["read", "bash", "edit", "write", "output"]);
  const session: FakeSession = {
    subscribe(cb) {
      listeners.push(cb);
    },
    state: { messages },
    prompts: [],
    aborts: 0,
    setActiveToolsCalls: [],
    callLog: [],
    activeTools: opts.activeTools ?? [...toolRegistry],
    activeToolsAtPrompt: [],
    getActiveToolNames() {
      return [...session.activeTools];
    },
    getAllTools() {
      return [...toolRegistry].map((name) => ({ name }));
    },
    setActiveToolsByName(toolNames: string[]) {
      session.setActiveToolsCalls.push([...toolNames]);
      session.callLog.push("set_active_tools");
      // Silent-drop semantics, per the SDK contract documented on
      // `PromptableSession.setActiveToolsByName`. A fake that accepted every
      // name would make the narrowing tests vacuous.
      session.activeTools = toolNames.filter((name) => toolRegistry.has(name));
    },
    async prompt(message: string) {
      session.prompts.push(message);
      session.callLog.push("prompt");
      session.activeToolsAtPrompt.push([...session.activeTools]);
      await session.onPrompt?.(message);
    },
    emit(event) {
      for (const cb of listeners) cb(event);
    },
    pushMessage(msg) {
      messages.push(msg);
    },
    reset() {
      listeners.length = 0;
      messages.length = 0;
    },
  };
  return session;
}

/**
 * Capture-all {@link EventSink}. Records every handled event and the
 * finalize argument for assertion.
 */
interface CaptureSink extends EventSink {
  events: RunEvent[];
  finalized: RunResult | null;
  finalizeCalls: number;
  handle: (event: RunEvent) => Promise<void>;
  finalize: (result: RunResult) => Promise<void>;
}

export function createCaptureSink(): CaptureSink {
  const events: RunEvent[] = [];
  const sink: CaptureSink = {
    events,
    finalized: null,
    finalizeCalls: 0,
    handle: async (event: RunEvent) => {
      events.push(event);
    },
    finalize: async (result: RunResult) => {
      sink.finalized = result;
      sink.finalizeCalls += 1;
    },
  };
  return sink;
}

/** Capture sink that forwards to {@link InternalSink.emit}. */
export function createInternalCapture(): InternalSink & { events: RunEvent[] } {
  const events: RunEvent[] = [];
  return {
    events,
    async emit(event) {
      events.push(event);
    },
  };
}

export function makeContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    runId: "run_test",
    input: {},
    memories: [],
    ...overrides,
  };
}

// ─── Bundle construction ─────────────────────────────────────────────

const TEST_ENC = new TextEncoder();

/**
 * Build a {@link BundlePackage} from a scoped name + version + file map.
 * `type` is baked into the package manifest so {@link prepareBundleForPi}'s
 * type-based partition (skill) picks up each dep correctly.
 */
export function makeBundlePackage(
  name: `@${string}/${string}`,
  version: string,
  type: "agent" | "skill",
  files: Record<string, string | Uint8Array> = {},
  extraManifest: Record<string, unknown> = {},
): BundlePackage {
  const identity = `${name}@${version}` as PackageIdentity;
  const manifest = { name, version, type, ...extraManifest };
  const filesMap = new Map<string, Uint8Array>();
  filesMap.set("manifest.json", TEST_ENC.encode(JSON.stringify(manifest)));
  for (const [k, v] of Object.entries(files)) {
    filesMap.set(k, typeof v === "string" ? TEST_ENC.encode(v) : v);
  }
  const integrity = recordIntegrity(serializeRecord(computeRecordEntries(filesMap)));
  return { identity, manifest, files: filesMap, integrity };
}

/** Build a {@link Bundle} from a root package + an arbitrary list of deps. */
export function makeTestBundle(root: BundlePackage, deps: BundlePackage[] = []): Bundle {
  const packages = new Map<PackageIdentity, BundlePackage>();
  packages.set(root.identity, root);
  for (const d of deps) packages.set(d.identity, d);
  const pkgIndex = new Map<PackageIdentity, { path: string; integrity: string }>();
  for (const p of packages.values()) {
    pkgIndex.set(p.identity, {
      path: `packages/${(p.manifest as { name: string }).name}/${(p.manifest as { version: string }).version}/`,
      integrity: p.integrity,
    });
  }
  return {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    root: root.identity,
    packages,
    integrity: bundleIntegrity(pkgIndex),
  };
}

/**
 * Subclass of {@link PiRunner} that replaces the session-creation
 * `executeSession` with a scripted generator. Tests pass a function
 * that runs events against a {@link FakeSession} hooked up to the real
 * `installSessionBridge`, avoiding the Pi SDK entirely.
 *
 * The override mirrors the production tail of `executeSession`: the bridge is
 * installed with the runner's `terminalTools` + early-stop callback, and the
 * real `maybeRepromptForOutput` runs once the script's "agent loop" settles.
 * A script that never emits a successful `output` therefore exercises the
 * missing-`output` re-prompt end to end through `run()`.
 */
type SessionScript = (
  session: FakeSession,
  ctx: ExecutionContext,
  signal: AbortSignal | undefined,
) => Promise<void>;

export class ScriptedPiRunner extends PiRunner {
  constructor(
    private readonly script: SessionScript,
    opts: Partial<ConstructorParameters<typeof PiRunner>[0]> = {},
  ) {
    super({
      model: {
        id: "test-model",
        name: "test-model",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "http://localhost",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 100,
      },
      systemPrompt: "you are a test",
      ...opts,
    });
  }

  protected override async executeSession(
    context: ExecutionContext,
    internalSink: InternalSink,
    signal: AbortSignal | undefined,
    onBridgeReady?: (handle: SessionBridgeHandle) => void,
  ): Promise<void> {
    const session = createFakeSession();
    const { installSessionBridge, maybeRepromptForOutput } = await import("../src/pi-runner.ts");
    const terminalTools = this.opts.terminalTools ?? [];
    const bridge = installSessionBridge(session, internalSink, context.runId, {
      terminalTools,
      onTerminalTool: () => {
        session.aborts += 1;
      },
    });
    onBridgeReady?.(bridge);
    await this.script(session, context, signal);
    await maybeRepromptForOutput({
      session,
      bridge,
      terminalTools,
      sink: internalSink,
      runId: context.runId,
      signal,
    });
  }
}
