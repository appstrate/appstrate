// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { zipSync } from "fflate";
import { writeFile } from "node:fs/promises";
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

export function buildBundleZip(
  opts: {
    manifest?: unknown;
    prompt?: string;
    extras?: Record<string, string | Uint8Array>;
  } = {},
): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "manifest.json": enc(JSON.stringify(opts.manifest ?? MINIMAL_MANIFEST)),
    "prompt.md": enc(opts.prompt ?? "Do {{input.task}} for {{runId}}."),
  };
  for (const [path, value] of Object.entries(opts.extras ?? {})) {
    files[path] = typeof value === "string" ? enc(value) : value;
  }
  return zipSync(files);
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
