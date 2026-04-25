// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Reference conformance adapter — thin glue between the suite and the
 * `@appstrate/afps-runtime` primitives. Third-party runners implement
 * the same {@link ConformanceAdapter} surface in their own language /
 * runtime.
 *
 * The L4 `runScripted` path replays the caller's `RunEvent[]` script
 * verbatim through a synthetic `EventSink` and reduces the stream into
 * a {@link RunResult} via {@link reduceEvents}. No runner class is
 * involved — the suite only validates the event / sink / reducer
 * contract.
 */

import { extractRootFromAfps } from "../bundle/build.ts";
import { bundleIntegrity, type RecordEntry } from "../bundle/integrity.ts";
import {
  BUNDLE_FORMAT_VERSION,
  parsePackageIdentity,
  type Bundle,
  type BundlePackage,
  type PackageIdentity,
} from "../bundle/types.ts";
import { verifyBundleSignature } from "../bundle/signing.ts";
import { renderPrompt } from "../bundle/prompt-renderer.ts";
import { reduceEvents } from "../runner/reducer.ts";
import type { EventSink } from "../interfaces/event-sink.ts";
import type { ExecutionContext } from "../types/execution-context.ts";
import type { RunEvent } from "@afps-spec/types";
import type { RunResult } from "../types/run-result.ts";
import type { ConformanceAdapter, RenderSnapshot, RunScriptedOutput } from "./adapter.ts";

export function createDefaultAdapter(): ConformanceAdapter {
  return {
    name: "@appstrate/afps-runtime",
    loadBundle: (bytes) => {
      // Conformance L1 tests provide single-package AFPS zips
      // (manifest.json + prompt.md at root). Wrap them into a
      // Bundle-of-1 synchronously — no catalog walk since any
      // declared deps cannot resolve in the test fixture.
      const root = extractRootFromAfps(bytes);
      // AFPS single-package agents mandate prompt.md at the root;
      // surfacing that check at load time preserves the loader-level
      // rejection semantics downstream consumers rely on.
      if (!root.files.has("prompt.md")) {
        throw new Error("afps: archive missing prompt.md");
      }
      return bundleOfOne(root);
    },
    renderPrompt: (template, context, snapshot) => {
      return renderPrompt({ template, context: mergeSnapshot(context, snapshot) });
    },
    verifySignature: (canonicalBytes, signatureDoc, trustRoot) =>
      verifyBundleSignature(canonicalBytes, signatureDoc, trustRoot),
    runScripted: async (_bundle, _context, scriptedEvents): Promise<RunScriptedOutput> => {
      const emitted: RunEvent[] = [];
      let finalizeCalls = 0;
      const sink: EventSink = {
        handle: async (event) => {
          emitted.push(event);
        },
        finalize: async () => {
          finalizeCalls++;
        },
      };

      for (const event of scriptedEvents) {
        await sink.handle(event);
      }
      const result: RunResult = reduceEvents(emitted);
      await sink.finalize(result);

      return { emitted, result, finalizeCalls };
    },
  };
}

function mergeSnapshot(context: ExecutionContext, snapshot: RenderSnapshot): ExecutionContext {
  return {
    ...context,
    ...(snapshot.memories !== undefined ? { memories: snapshot.memories } : {}),
    ...(snapshot.history !== undefined ? { history: snapshot.history } : {}),
    ...(snapshot.state !== undefined ? { state: snapshot.state } : {}),
  };
}

function bundleOfOne(root: BundlePackage): Bundle {
  const parsed = parsePackageIdentity(root.identity);
  if (!parsed) throw new Error(`invalid identity ${root.identity}`);
  const pkgIndex = new Map<PackageIdentity, { path: string; integrity: string }>();
  pkgIndex.set(root.identity, {
    path: `packages/@${parsed.scope}/${parsed.name}/${parsed.version}/`,
    integrity: root.integrity,
  });
  return {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    root: root.identity,
    packages: new Map([[root.identity, root]]),
    integrity: bundleIntegrity(pkgIndex),
  };
}

// Silence unused import warning — RecordEntry is re-exported below as
// a convenience for downstream adapters that want to introspect integrity
// entries against their own implementation.
export type { RecordEntry };
