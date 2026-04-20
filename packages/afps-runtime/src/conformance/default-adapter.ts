// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Reference conformance adapter — thin glue between the suite and
 * the `@appstrate/afps-runtime` primitives. Third-party runners
 * implement the same {@link ConformanceAdapter} surface in their own
 * language / runtime.
 */

import { loadBundleFromBuffer } from "../bundle/loader.ts";
import { verifyBundleSignature } from "../bundle/signing.ts";
import { renderPrompt } from "../bundle/prompt-renderer.ts";
import { SnapshotContextProvider } from "../providers/context/snapshot-provider.ts";
import type { ConformanceAdapter } from "./adapter.ts";

export function createDefaultAdapter(): ConformanceAdapter {
  return {
    name: "@appstrate/afps-runtime",
    loadBundle: (bytes) => loadBundleFromBuffer(bytes),
    renderPrompt: (template, context, snapshot) => {
      const provider = new SnapshotContextProvider(snapshot);
      return renderPrompt({ template, context, provider });
    },
    verifySignature: (canonicalBytes, signatureDoc, trustRoot) =>
      verifyBundleSignature(canonicalBytes, signatureDoc, trustRoot),
  };
}
