// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { readBundleFromBuffer } from "../../bundle/read.ts";
import { renderPrompt } from "../../bundle/prompt-renderer.ts";
import type { ExecutionContext } from "../../types/execution-context.ts";
import type { CliIO } from "../index.ts";

const HELP = `afps render — dry-run render of a bundle's prompt template

Usage:
  afps render <bundle> [--context <path>] [--snapshot <path>]

Options:
  --context <path>    JSON file with render context (runId, input, …).
                      Fields omitted default to empty.
  --snapshot <path>   JSON file with { memories?, state?, history? }
                      merged onto the context before rendering.

The rendered prompt is printed to stdout with no headers or framing so
it can be piped into other tools.
`;

interface RenderContextFile {
  runId?: string;
  input?: unknown;
  [key: string]: unknown;
}

interface SnapshotFile {
  memories?: ExecutionContext["memories"];
  history?: ExecutionContext["history"];
  state?: unknown;
}

export async function run(argv: readonly string[], io: CliIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        context: { type: "string" },
        snapshot: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`afps render: ${(err as Error).message}\n`);
    io.stderr(HELP);
    return 2;
  }
  if (parsed.values.help) {
    io.stdout(HELP);
    return 0;
  }
  const [bundlePath] = parsed.positionals;
  if (!bundlePath) {
    io.stderr("afps render: missing <bundle> argument\n");
    io.stderr(HELP);
    return 2;
  }

  const bundleBytes = await readFile(bundlePath);
  const bundle = readBundleFromBuffer(new Uint8Array(bundleBytes));
  const rootPkg = bundle.packages.get(bundle.root);
  const promptBytes = rootPkg?.files.get("prompt.md");
  const template = promptBytes ? new TextDecoder().decode(promptBytes) : "";

  let contextFile: RenderContextFile = {};
  if (parsed.values.context) {
    try {
      contextFile = JSON.parse(await readFile(parsed.values.context, "utf-8")) as RenderContextFile;
    } catch (err) {
      io.stderr(`afps render: cannot read context file: ${(err as Error).message}\n`);
      return 1;
    }
  }

  let snapshot: SnapshotFile = {};
  if (parsed.values.snapshot) {
    try {
      snapshot = JSON.parse(await readFile(parsed.values.snapshot, "utf-8")) as SnapshotFile;
    } catch (err) {
      io.stderr(`afps render: cannot read snapshot file: ${(err as Error).message}\n`);
      return 1;
    }
  }

  const context: ExecutionContext = {
    runId: contextFile.runId ?? "cli-dry-run",
    input: contextFile.input ?? {},
    ...contextFile,
    ...(snapshot.memories !== undefined ? { memories: snapshot.memories } : {}),
    ...(snapshot.history !== undefined ? { history: snapshot.history } : {}),
    ...(snapshot.state !== undefined ? { state: snapshot.state } : {}),
  };
  const rendered = await renderPrompt({
    template,
    context,
  });
  io.stdout(rendered);
  if (!rendered.endsWith("\n")) io.stdout("\n");
  return 0;
}
