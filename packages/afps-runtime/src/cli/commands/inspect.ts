// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { parseArgs } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { readBundleFromBuffer } from "../../bundle/read.ts";
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
  const compressedSize = (await stat(bundlePath)).size;
  const bundle = readBundleFromBuffer(new Uint8Array(bundleBytes));
  const signature = readBundleSignature(bundle);

  const rootPkg = bundle.packages.get(bundle.root);
  const rootManifest = (rootPkg?.manifest ?? {}) as Record<string, unknown>;
  const promptBytes = rootPkg?.files.get("prompt.md");
  const prompt = promptBytes ? new TextDecoder().decode(promptBytes) : "";
  const totalDecompressed = [...bundle.packages.values()].reduce(
    (n, p) => n + [...p.files.values()].reduce((m, b) => m + b.byteLength, 0),
    0,
  );

  if (parsed.values.json) {
    const report = {
      bundle: bundlePath,
      bundleFormatVersion: bundle.bundleFormatVersion,
      root: bundle.root,
      compressedSize,
      decompressedSize: totalDecompressed,
      manifest: rootManifest,
      promptBytes: promptBytes?.byteLength ?? 0,
      packages: [...bundle.packages.keys()].sort().map((id) => ({
        identity: id,
        files: [...bundle.packages.get(id)!.files.keys()].sort(),
      })),
      signature: signature
        ? { alg: signature.alg, keyId: signature.keyId, chainLength: signature.chain?.length ?? 0 }
        : null,
    };
    io.stdout(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }

  io.stdout(`Bundle: ${bundlePath}\n`);
  io.stdout(`  bundleFormatVersion: ${bundle.bundleFormatVersion}\n`);
  io.stdout(`  root:          ${bundle.root}\n`);
  io.stdout(`  name:          ${String(rootManifest["name"] ?? "<unknown>")}\n`);
  io.stdout(`  version:       ${String(rootManifest["version"] ?? "<unknown>")}\n`);
  io.stdout(`  type:          ${String(rootManifest["type"] ?? "<unknown>")}\n`);
  io.stdout(`  schemaVersion: ${String(rootManifest["schemaVersion"] ?? "<unknown>")}\n`);
  io.stdout(`  size:          ${compressedSize}B zipped / ${totalDecompressed}B raw\n`);
  io.stdout(`  packages:      ${bundle.packages.size}\n`);
  for (const [identity, pkg] of [...bundle.packages.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    io.stdout(`    - ${identity} (${pkg.files.size} files)\n`);
    for (const path of [...pkg.files.keys()].sort()) {
      io.stdout(`        · ${path} (${pkg.files.get(path)!.byteLength}B)\n`);
    }
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
  const preview = prompt.slice(0, PROMPT_PREVIEW_CHARS);
  io.stdout(`\nPrompt (${prompt.length} chars):\n`);
  io.stdout(preview);
  if (prompt.length > PROMPT_PREVIEW_CHARS) {
    io.stdout(`\n… (${prompt.length - PROMPT_PREVIEW_CHARS} more chars)`);
  }
  io.stdout("\n");
  return 0;
}
