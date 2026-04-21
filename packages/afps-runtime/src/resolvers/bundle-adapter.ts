// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { Bundle } from "./types.ts";
import type { LoadedBundle } from "../bundle/loader.ts";
import { computeIntegrity } from "../bundle/hash.ts";

/**
 * Adapter that lifts a {@link LoadedBundle} (the runtime's in-memory
 * representation of a decompressed `.afps` file) into the spec-level
 * {@link Bundle} surface that resolvers consume.
 *
 * Kept as a function rather than an interface: loaders already produce
 * a concrete `LoadedBundle`, and exposing only the narrow `Bundle` view
 * to resolvers guarantees they cannot reach into runtime-private fields.
 */
export interface BundleAdapter extends Bundle {
  /** The underlying runtime bundle, for advanced resolvers that need more. */
  readonly loaded: LoadedBundle;
}

const TEXT_DECODER = new TextDecoder();

/**
 * Wrap a {@link LoadedBundle} as a spec-level {@link Bundle}. The digest
 * is computed lazily on first access so callers that do not need it
 * (e.g. tests, simple in-memory runners) do not pay the hash cost.
 */
export function toBundle(loaded: LoadedBundle): BundleAdapter {
  let cachedDigest: string | undefined;

  return {
    loaded,
    manifest: loaded.manifest,
    get digest(): string {
      if (cachedDigest === undefined) {
        cachedDigest = computeIntegrity(toCanonicalBytes(loaded));
      }
      return cachedDigest;
    },
    async read(path: string): Promise<Uint8Array> {
      const entry = loaded.files[normalisePath(path)];
      if (!entry) throw new Error(`bundle entry not found: ${path}`);
      return entry;
    },
    async readText(path: string): Promise<string> {
      const entry = loaded.files[normalisePath(path)];
      if (!entry) throw new Error(`bundle entry not found: ${path}`);
      return TEXT_DECODER.decode(entry);
    },
    async exists(path: string): Promise<boolean> {
      return Object.prototype.hasOwnProperty.call(loaded.files, normalisePath(path));
    },
  };
}

function normalisePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\\/g, "/");
}

/**
 * Deterministic canonical byte sequence of a LoadedBundle suitable for
 * hashing — entries sorted by path, joined with length-prefixed framing.
 */
function toCanonicalBytes(bundle: LoadedBundle): Uint8Array {
  const keys = Object.keys(bundle.files).sort();
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const key of keys) {
    const pathBytes = encoder.encode(`${key}\n`);
    const entry = bundle.files[key]!;
    const lengthBytes = encoder.encode(`${entry.length}\n`);
    chunks.push(pathBytes, lengthBytes, entry, encoder.encode("\n"));
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
