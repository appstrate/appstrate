// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { loadBundleFromBuffer } from "../../bundle/loader.ts";
import { renderPrompt } from "../../bundle/prompt-renderer.ts";
import {
  SnapshotContextProvider,
  type ContextSnapshot,
} from "../../providers/context/snapshot-provider.ts";
import type { ExecutionContext } from "../../types/execution-context.ts";
import type { CliIO } from "../index.ts";

const HELP = `afps render — dry-run render of a bundle's prompt template

Usage:
  afps render <bundle> [--context <path>] [--snapshot <path>]

Options:
  --context <path>    JSON file with render context (runId, input, …).
                      Fields omitted default to empty.
  --snapshot <path>   JSON file with a ContextSnapshot
                      ({ memories?, state?, history? }) used by the
                      SnapshotContextProvider.

The rendered prompt is printed to stdout with no headers or framing so
it can be piped into other tools.
`;

interface RenderContextFile {
  runId?: string;
  input?: unknown;
  [key: string]: unknown;
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
  const bundle = loadBundleFromBuffer(bundleBytes);

  let context: RenderContextFile = {};
  if (parsed.values.context) {
    try {
      context = JSON.parse(await readFile(parsed.values.context, "utf-8")) as RenderContextFile;
    } catch (err) {
      io.stderr(`afps render: cannot read context file: ${(err as Error).message}\n`);
      return 1;
    }
  }

  let snapshot: ContextSnapshot | undefined;
  if (parsed.values.snapshot) {
    try {
      snapshot = JSON.parse(await readFile(parsed.values.snapshot, "utf-8")) as ContextSnapshot;
    } catch (err) {
      io.stderr(`afps render: cannot read snapshot file: ${(err as Error).message}\n`);
      return 1;
    }
  }

  const provider = new SnapshotContextProvider(snapshot);
  const resolved: ExecutionContext = {
    runId: context.runId ?? "cli-dry-run",
    input: context.input ?? {},
    ...context,
  };
  const rendered = await renderPrompt({
    template: bundle.prompt,
    context: resolved,
    provider,
  });
  io.stdout(rendered);
  if (!rendered.endsWith("\n")) io.stdout("\n");
  return 0;
}
