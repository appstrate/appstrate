// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { readBundleFromBuffer } from "../../bundle/read.ts";
import { writeBundleToBuffer } from "../../bundle/write.ts";
import { canonicalBundleDigest, signBundle, type TrustChainEntry } from "../../bundle/signing.ts";
import { recordIntegrity, serializeRecord, computeRecordEntries } from "../../bundle/integrity.ts";
import type { Bundle } from "../../bundle/types.ts";
import type { CliIO } from "../index.ts";

const HELP = `afps sign — produce signature.sig for a bundle

Usage:
  afps sign <bundle> --key <key.json> [options]

Options:
  --key <path>          JSON file with { keyId, publicKey, privateKey }
  --key-id <id>         Override the keyId declared in the signature
  --chain <path>        JSON file: array of TrustChainEntry
  --out <path>          Output path (default: rewrite <bundle> in place)
`;

interface KeyFile {
  keyId: string;
  publicKey: string;
  privateKey: string;
}

/**
 * Flatten a Bundle's root package files into the `Record<string, Uint8Array>`
 * shape `canonicalBundleDigest` expects. The signature semantics cover the
 * root package — deps get their own per-package integrity via RECORD.
 */
function rootFilesRecord(bundle: Bundle): Record<string, Uint8Array> {
  const rootPkg = bundle.packages.get(bundle.root);
  if (!rootPkg) throw new Error(`bundle root ${bundle.root} is not in packages map`);
  const out: Record<string, Uint8Array> = {};
  for (const [p, bytes] of rootPkg.files) {
    if (p === "RECORD") continue;
    out[p] = bytes;
  }
  return out;
}

export async function run(argv: readonly string[], io: CliIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        key: { type: "string" },
        "key-id": { type: "string" },
        chain: { type: "string" },
        out: { type: "string", short: "o" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`afps sign: ${(err as Error).message}\n`);
    io.stderr(HELP);
    return 2;
  }
  if (parsed.values.help) {
    io.stdout(HELP);
    return 0;
  }

  const [bundlePath] = parsed.positionals;
  if (!bundlePath) {
    io.stderr("afps sign: missing <bundle> argument\n");
    io.stderr(HELP);
    return 2;
  }
  const keyPath = parsed.values.key;
  if (!keyPath) {
    io.stderr("afps sign: --key <path> is required\n");
    return 2;
  }

  let keyFile: KeyFile;
  try {
    keyFile = JSON.parse(await readFile(keyPath, "utf-8")) as KeyFile;
  } catch (err) {
    io.stderr(`afps sign: cannot read key file ${keyPath}: ${(err as Error).message}\n`);
    return 1;
  }
  if (!keyFile.privateKey || !keyFile.keyId) {
    io.stderr("afps sign: key file must contain { keyId, privateKey }\n");
    return 1;
  }

  let chain: TrustChainEntry[] | undefined;
  if (parsed.values.chain) {
    try {
      const parsedChain: unknown = JSON.parse(await readFile(parsed.values.chain, "utf-8"));
      if (!Array.isArray(parsedChain)) {
        io.stderr("afps sign: --chain file must contain a JSON array\n");
        return 1;
      }
      chain = parsedChain as TrustChainEntry[];
    } catch (err) {
      io.stderr(`afps sign: cannot read chain file: ${(err as Error).message}\n`);
      return 1;
    }
  }

  const bundleBytes = await readFile(bundlePath);
  const bundle = readBundleFromBuffer(new Uint8Array(bundleBytes));

  const canonical = canonicalBundleDigest(rootFilesRecord(bundle));
  const signature = signBundle(canonical, {
    privateKey: keyFile.privateKey,
    keyId: parsed.values["key-id"] ?? keyFile.keyId,
    chain,
  });

  // Inject signature.sig into the root package and rebuild the bundle.
  const rootPkg = bundle.packages.get(bundle.root)!;
  const enc = new TextEncoder();
  const updatedFiles = new Map(rootPkg.files);
  updatedFiles.set("signature.sig", enc.encode(JSON.stringify(signature, null, 2) + "\n"));
  // Re-compute RECORD + per-package integrity since files changed.
  const recordBody = serializeRecord(computeRecordEntries(updatedFiles));
  const updatedIntegrity = recordIntegrity(recordBody);
  const updatedBundle: Bundle = {
    ...bundle,
    packages: new Map([
      ...bundle.packages,
      [
        bundle.root,
        {
          ...rootPkg,
          files: updatedFiles,
          integrity: updatedIntegrity,
        },
      ],
    ]),
  };

  const newZip = writeBundleToBuffer(updatedBundle);
  const outPath = parsed.values.out ?? bundlePath;
  await writeFile(outPath, newZip);
  io.stdout(`signed ${bundlePath} → ${outPath} (keyId: ${signature.keyId})\n`);
  return 0;
}
