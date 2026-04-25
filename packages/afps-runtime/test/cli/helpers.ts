// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { writeFile } from "node:fs/promises";
import { writeBundleToBuffer } from "../../src/bundle/write.ts";
import {
  BUNDLE_FORMAT_VERSION,
  type Bundle,
  type PackageIdentity,
} from "../../src/bundle/types.ts";
import {
  bundleIntegrity,
  computeRecordEntries,
  recordIntegrity,
  serializeRecord,
} from "../../src/bundle/integrity.ts";
import type { CliIO } from "../../src/cli/index.ts";

export interface CapturedIo extends CliIO {
  stdoutText: () => string;
  stderrText: () => string;
  stdoutChunks: string[];
  stderrChunks: string[];
}

export function captureIo(): CapturedIo {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  return {
    stdout: (chunk) => stdoutChunks.push(chunk),
    stderr: (chunk) => stderrChunks.push(chunk),
    stdoutChunks,
    stderrChunks,
    stdoutText: () => stdoutChunks.join(""),
    stderrText: () => stderrChunks.join(""),
  };
}

export const MINIMAL_MANIFEST = {
  name: "@acme/hello",
  version: "1.0.0",
  type: "agent",
  schemaVersion: "1.1",
  displayName: "Hello",
  author: "Acme",
};

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Build a valid multi-package `.afps-bundle` ZIP with a single agent
 * package at the root. Extras flatten into the root package's files
 * alongside manifest.json + prompt.md.
 */
export function buildBundleZip(
  opts: {
    manifest?: Record<string, unknown>;
    prompt?: string;
    extras?: Record<string, string | Uint8Array>;
  } = {},
): Uint8Array {
  const manifest = (opts.manifest ?? MINIMAL_MANIFEST) as Record<string, unknown>;
  const name = (manifest.name as string | undefined) ?? "@acme/hello";
  const version = (manifest.version as string | undefined) ?? "1.0.0";
  const identity = `${name}@${version}` as PackageIdentity;
  const files = new Map<string, Uint8Array>();
  files.set("manifest.json", enc(JSON.stringify(manifest)));
  files.set("prompt.md", enc(opts.prompt ?? "Do {{input.task}} for {{runId}}."));
  for (const [path, value] of Object.entries(opts.extras ?? {})) {
    files.set(path, typeof value === "string" ? enc(value) : value);
  }
  const integrity = recordIntegrity(serializeRecord(computeRecordEntries(files)));
  const bundle: Bundle = {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    root: identity,
    packages: new Map([[identity, { identity, manifest, files, integrity }]]),
    integrity: bundleIntegrity(
      new Map([[identity, { path: `packages/${name}/${version}/`, integrity }]]),
    ),
  };
  return writeBundleToBuffer(bundle);
}

export async function writeBundleFile(
  path: string,
  opts: Parameters<typeof buildBundleZip>[0] = {},
): Promise<void> {
  await writeFile(path, buildBundleZip(opts));
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2));
}
