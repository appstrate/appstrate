// SPDX-License-Identifier: Apache-2.0

/**
 * Test helpers for PiRunner unit tests. Centralises the small
 * primitives (mock session, capture sink, test subclass) so every
 * test file reads the same way.
 */

import type { BridgeableSession, InternalSink } from "../src/pi-runner.ts";
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
export interface FakeSession extends BridgeableSession {
  /** Drive a raw Pi SDK event onto the bridge. */
  emit(event: unknown): void;
  /** Append a message to `state.messages` (used by message_end handler). */
  pushMessage(msg: unknown): void;
  /** Clear all listeners — lets tests assert "no leaks after run". */
  reset(): void;
}

export function createFakeSession(): FakeSession {
  const listeners: Array<(event: unknown) => void> = [];
  const messages: unknown[] = [];
  return {
    subscribe(cb) {
      listeners.push(cb);
    },
    state: { messages },
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
}

/**
 * Capture-all {@link EventSink}. Records every handled event and the
 * finalize argument for assertion.
 */
export interface CaptureSink extends EventSink {
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
    config: {},
    ...overrides,
  };
}

// ─── Bundle construction ─────────────────────────────────────────────

const TEST_ENC = new TextEncoder();

/**
 * Build a {@link BundlePackage} from a scoped name + version + file map.
 * `type` is baked into the package manifest so {@link prepareBundleForPi}'s
 * type-based partition (skill/provider/tool) picks up each dep correctly.
 */
export function makeBundlePackage(
  name: `@${string}/${string}`,
  version: string,
  type: "agent" | "tool" | "skill" | "provider",
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
 */
export type SessionScript = (
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
    onBridgeReady?: (handle: import("../src/pi-runner.ts").SessionBridgeHandle) => void,
  ): Promise<void> {
    const session = createFakeSession();
    const { installSessionBridge } = await import("../src/pi-runner.ts");
    onBridgeReady?.(installSessionBridge(session, internalSink, context.runId));
    await this.script(session, context, signal);
  }
}
