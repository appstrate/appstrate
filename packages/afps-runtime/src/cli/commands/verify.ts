// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { loadBundleFromBuffer } from "../../bundle/loader.ts";
import { validateBundle } from "../../bundle/validator.ts";
import {
  canonicalBundleDigest,
  readBundleSignature,
  verifyBundleSignature,
  type TrustRoot,
} from "../../bundle/signing.ts";
import type { CliIO } from "../index.ts";

const HELP = `afps verify — validate a bundle and verify its signature

Usage:
  afps verify <bundle> [--trust-root <path>]

Options:
  --trust-root <path>     JSON { keys: [{keyId, publicKey}] }. Required
                          if --require-signature is set.
  --require-signature     Fail if the bundle has no signature.sig or
                          no --trust-root is provided.

Exit codes:
  0   bundle valid (signature check skipped or passed)
  1   manifest / template validation failed
  2   usage error
  3   signature verification failed
`;

export async function run(argv: readonly string[], io: CliIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        "trust-root": { type: "string" },
        "require-signature": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`afps verify: ${(err as Error).message}\n`);
    io.stderr(HELP);
    return 2;
  }
  if (parsed.values.help) {
    io.stdout(HELP);
    return 0;
  }
  const [bundlePath] = parsed.positionals;
  if (!bundlePath) {
    io.stderr("afps verify: missing <bundle> argument\n");
    io.stderr(HELP);
    return 2;
  }

  const bundleBytes = await readFile(bundlePath);
  const bundle = loadBundleFromBuffer(bundleBytes);

  const validation = validateBundle(bundle);
  if (!validation.valid) {
    io.stderr(`afps verify: ${validation.issues.length} validation issue(s):\n`);
    for (const issue of validation.issues) {
      io.stderr(`  [${issue.code}] ${issue.path}: ${issue.message}\n`);
    }
    return 1;
  }
  io.stdout(`✓ manifest + template valid (${Object.keys(bundle.files).length} files)\n`);

  const signature = readBundleSignature(bundle);
  const requireSig = parsed.values["require-signature"] === true;
  const trustRootPath = parsed.values["trust-root"];

  if (!signature) {
    if (requireSig) {
      io.stderr("afps verify: bundle has no signature.sig (required)\n");
      return 3;
    }
    io.stdout("• no signature.sig (unsigned bundle)\n");
    return 0;
  }

  if (!trustRootPath) {
    if (requireSig) {
      io.stderr("afps verify: --trust-root is required with --require-signature\n");
      return 2;
    }
    io.stdout(`• signature present (keyId: ${signature.keyId}) — skipped (no --trust-root)\n`);
    return 0;
  }

  let trustRoot: TrustRoot;
  try {
    trustRoot = JSON.parse(await readFile(trustRootPath, "utf-8")) as TrustRoot;
  } catch (err) {
    io.stderr(`afps verify: cannot read trust root: ${(err as Error).message}\n`);
    return 2;
  }

  const canonical = canonicalBundleDigest(bundle.files);
  const result = verifyBundleSignature(canonical, signature, trustRoot);
  if (!result.ok) {
    io.stderr(`✗ signature verification failed: ${result.reason}`);
    if (result.detail) io.stderr(` — ${result.detail}`);
    io.stderr("\n");
    return 3;
  }
  io.stdout(`✓ signature valid (keyId: ${result.keyId})\n`);
  return 0;
}
