// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { parseArgs } from "node:util";
import { writeFile, chmod } from "node:fs/promises";
import { generateKeyPair } from "../../bundle/signing.ts";
import type { CliIO } from "../index.ts";

const HELP = `afps keygen — generate an Ed25519 key pair

Usage:
  afps keygen [--out <path>] [--key-id <id>]

Options:
  --out, -o <path>    Write key pair JSON to <path> (mode 0600). If
                      omitted, the JSON is printed to stdout.
  --key-id <id>       Override the auto-derived keyId.
`;

export async function run(argv: readonly string[], io: CliIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        out: { type: "string", short: "o" },
        "key-id": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    io.stderr(`afps keygen: ${(err as Error).message}\n`);
    io.stderr(HELP);
    return 2;
  }
  if (parsed.values.help) {
    io.stdout(HELP);
    return 0;
  }

  const kp = generateKeyPair();
  if (parsed.values["key-id"]) {
    kp.keyId = parsed.values["key-id"];
  }
  const json = JSON.stringify(kp, null, 2) + "\n";

  const out = parsed.values.out;
  if (out) {
    await writeFile(out, json);
    await chmod(out, 0o600);
    io.stdout(`wrote Ed25519 key pair to ${out} (keyId: ${kp.keyId})\n`);
  } else {
    io.stdout(json);
  }
  return 0;
}
