// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { loadAnyBundleFromBuffer } from "../../bundle/bridge.ts";
import { ConsoleSink } from "../../sinks/console-sink.ts";
import { FileSink } from "../../sinks/file-sink.ts";
import { CompositeSink } from "../../sinks/composite-sink.ts";
import { reduceEvents } from "../../runner/reducer.ts";
import type { RunEvent } from "../../types/run-event.ts";
import type { EventSink } from "../../interfaces/event-sink.ts";
import type { CliIO } from "../index.ts";

const HELP = `afps run — replay a scripted agent run through a bundle

Usage:
  afps run <bundle> --events <path> [options]

Options:
  --events <path>     JSON array of RunEvent to replay through the sink.
                      Each event must have \`type\`, \`timestamp\`, and
                      \`runId\`; remaining fields are payload.
  --output <path>     Write the aggregated RunResult as JSON to <path>.
  --sink console|file|both   Sink strategy (default: console).
  --sink-file <path>  File path when --sink=file|both (defaults to
                      <bundle>.events.jsonl).
  --quiet             Suppress ConsoleSink output even when selected.

Scripted replay exercises the sink + reducer contract only. No LLM is
invoked and no network call is made — the command is suitable for
deterministic fixtures, conformance demos, and regression tests.
`;

export async function run(argv: readonly string[], io: CliIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        events: { type: "string" },
        output: { type: "string" },
        sink: { type: "string" },
        "sink-file": { type: "string" },
        quiet: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr(`afps run: ${(err as Error).message}\n`);
    io.stderr(HELP);
    return 2;
  }
  if (parsed.values.help) {
    io.stdout(HELP);
    return 0;
  }

  const [bundlePath] = parsed.positionals;
  if (!bundlePath) {
    io.stderr("afps run: missing <bundle> argument\n");
    io.stderr(HELP);
    return 2;
  }
  if (!parsed.values.events) {
    io.stderr("afps run: --events <path> is required\n");
    return 2;
  }

  const events = await readEvents(parsed.values.events, io);
  if (!events) return 1;

  // Bundle is parsed to validate its shape, but not otherwise consumed
  // by scripted replay — the sink + reducer contract is independent of
  // the bundle's prompt content.
  const bundleBytes = await readFile(bundlePath);
  loadAnyBundleFromBuffer(bundleBytes);

  const sink = await buildSink(parsed.values, bundlePath, io);
  if (!sink) return 1;

  for (const event of events) {
    await sink.handle(event);
  }
  const result = reduceEvents(events);
  await sink.finalize(result);

  if (parsed.values.output) {
    await writeFile(parsed.values.output, JSON.stringify(result, null, 2) + "\n");
    io.stdout(`→ wrote RunResult to ${parsed.values.output}\n`);
  }
  return 0;
}

async function readEvents(path: string, io: CliIO): Promise<RunEvent[] | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf-8"));
  } catch (err) {
    io.stderr(`afps run: cannot read events file: ${(err as Error).message}\n`);
    return null;
  }
  if (!Array.isArray(raw)) {
    io.stderr("afps run: --events file must contain a JSON array\n");
    return null;
  }
  const events: RunEvent[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ev = raw[i];
    if (
      typeof ev !== "object" ||
      ev === null ||
      Array.isArray(ev) ||
      typeof (ev as { type?: unknown }).type !== "string" ||
      typeof (ev as { timestamp?: unknown }).timestamp !== "number" ||
      typeof (ev as { runId?: unknown }).runId !== "string"
    ) {
      io.stderr(`afps run: invalid event at index ${i}: expected { type, timestamp, runId, … }\n`);
      return null;
    }
    events.push(ev as RunEvent);
  }
  return events;
}

async function buildSink(
  values: Record<string, string | boolean | undefined>,
  bundlePath: string,
  io: CliIO,
): Promise<EventSink | null> {
  const mode = (values.sink as string | undefined) ?? "console";
  const quiet = values.quiet === true;
  const sinkFile = (values["sink-file"] as string | undefined) ?? `${bundlePath}.events.jsonl`;

  const sinks: EventSink[] = [];
  if ((mode === "console" || mode === "both") && !quiet) {
    sinks.push(new ConsoleSink({ out: { write: (chunk) => io.stdout(chunk) } }));
  }
  if (mode === "file" || mode === "both") {
    sinks.push(new FileSink({ path: sinkFile }));
  }
  if (mode !== "console" && mode !== "file" && mode !== "both") {
    io.stderr(`afps run: unknown --sink '${mode}' (console|file|both)\n`);
    return null;
  }
  if (sinks.length === 0) {
    return {
      handle: async () => undefined,
      finalize: async () => undefined,
    };
  }
  return sinks.length === 1 ? sinks[0]! : new CompositeSink(sinks);
}
