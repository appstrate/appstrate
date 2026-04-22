// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { loadAnyBundleFromBuffer } from "../../bundle/bridge.ts";
import { readBundleSignature } from "../../bundle/signing.ts";
import type { CliIO } from "../index.ts";

const HELP = `afps inspect — print bundle metadata

Usage:
  afps inspect <bundle> [--json]

Options:
  --json                 Emit a single JSON document to stdout instead
                         of a human-readable report.
`;

const PROMPT_PREVIEW_CHARS = 500;

export async function run(argv: readonly string[], io: CliIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`afps inspect: ${(err as Error).message}\n`);
    io.stderr(HELP);
    return 2;
  }
  if (parsed.values.help) {
    io.stdout(HELP);
    return 0;
  }
  const [bundlePath] = parsed.positionals;
  if (!bundlePath) {
    io.stderr("afps inspect: missing <bundle> argument\n");
    io.stderr(HELP);
    return 2;
  }

  const bundleBytes = await readFile(bundlePath);
  const bundle = loadAnyBundleFromBuffer(bundleBytes);
  const signature = readBundleSignature(bundle);

  if (parsed.values.json) {
    const report = {
      bundle: bundlePath,
      compressedSize: bundle.compressedSize,
      decompressedSize: bundle.decompressedSize,
      manifest: bundle.manifest,
      promptBytes: new TextEncoder().encode(bundle.prompt).length,
      files: Object.keys(bundle.files).sort(),
      signature: signature
        ? { alg: signature.alg, keyId: signature.keyId, chainLength: signature.chain?.length ?? 0 }
        : null,
    };
    io.stdout(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }

  const m = bundle.manifest;
  io.stdout(`Bundle: ${bundlePath}\n`);
  io.stdout(`  name:          ${String(m["name"] ?? "<unknown>")}\n`);
  io.stdout(`  version:       ${String(m["version"] ?? "<unknown>")}\n`);
  io.stdout(`  type:          ${String(m["type"] ?? "<unknown>")}\n`);
  io.stdout(`  schemaVersion: ${String(m["schemaVersion"] ?? "<unknown>")}\n`);
  io.stdout(
    `  size:          ${bundle.compressedSize}B zipped / ${bundle.decompressedSize}B raw\n`,
  );
  io.stdout(`  files:         ${Object.keys(bundle.files).length}\n`);
  for (const path of Object.keys(bundle.files).sort()) {
    io.stdout(`    - ${path} (${bundle.files[path]!.length}B)\n`);
  }
  if (signature) {
    io.stdout(`  signature:     ${signature.alg} keyId=${signature.keyId}`);
    if (signature.chain && signature.chain.length > 0) {
      io.stdout(` chain=${signature.chain.length}`);
    }
    io.stdout("\n");
  } else {
    io.stdout(`  signature:     <none>\n`);
  }
  const preview = bundle.prompt.slice(0, PROMPT_PREVIEW_CHARS);
  io.stdout(`\nPrompt (${bundle.prompt.length} chars):\n`);
  io.stdout(preview);
  if (bundle.prompt.length > PROMPT_PREVIEW_CHARS) {
    io.stdout(`\n… (${bundle.prompt.length - PROMPT_PREVIEW_CHARS} more chars)`);
  }
  io.stdout("\n");
  return 0;
}
