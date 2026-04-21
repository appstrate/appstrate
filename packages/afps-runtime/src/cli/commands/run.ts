// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { loadBundleFromBuffer } from "../../bundle/loader.ts";
import { MockRunner } from "../../runner/mock.ts";
import { PiRunner, type PiModelApi } from "../../runner/pi.ts";
import type { BundleRunner } from "../../runner/types.ts";
import { ConsoleSink } from "../../sinks/console-sink.ts";
import { FileSink } from "../../sinks/file-sink.ts";
import { CompositeSink } from "../../sinks/composite-sink.ts";
import {
  SnapshotContextProvider,
  type ContextSnapshot,
} from "../../providers/context/snapshot-provider.ts";
import { afpsEventSchema, type AfpsEvent } from "../../types/afps-event.ts";
import type { ExecutionContext } from "../../types/execution-context.ts";
import type { EventSink } from "../../interfaces/event-sink.ts";
import type { CliIO } from "../index.ts";

const HELP = `afps run — execute a bundle

Usage:
  afps run <bundle> [options]

Runners:
  --runner mock              (default) Replay --events through MockRunner
  --runner pi                Execute against an LLM via the Pi Coding Agent SDK
                             (requires '@mariozechner/pi-coding-agent' +
                             '@mariozechner/pi-ai')

MockRunner options (required with --runner mock):
  --events <path>            JSON array of AfpsEvent to replay

PiRunner options (required with --runner pi):
  --model <id>               LLM model id (e.g. claude-opus-4-7, gpt-4o-mini)
  --api <pi-api>             Pi API id: anthropic-messages | openai-completions
                             | openai-responses | google-generative-ai
                             | mistral-conversations
  --api-key <key>            Provider API key (or set LLM_API_KEY env var)
  --provider <slug>          Explicit provider slug — derived from --api if omitted
  --base-url <url>           Override the provider base URL (e.g. OpenRouter,
                             self-hosted OpenAI-compatible endpoints)
  --thinking off|low|medium|high   Default: medium

Common options:
  --context <path>    JSON file: { runId?, input? } (ExecutionContext).
                      Defaults to { runId: "cli-run", input: {} }.
  --snapshot <path>   JSON file: ContextSnapshot (memories/state/history)
                      used by the SnapshotContextProvider.
  --output <path>     Write the final RunResult as JSON to <path>.
  --sink console|file|both   Sink strategy (default: console).
  --sink-file <path>  File path when --sink=file|both (defaults to
                      <bundle>.events.jsonl).
  --quiet             Suppress ConsoleSink output even when selected.
`;

interface RunContextFile {
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
        runner: { type: "string" },
        events: { type: "string" },
        model: { type: "string" },
        api: { type: "string" },
        "api-key": { type: "string" },
        provider: { type: "string" },
        "base-url": { type: "string" },
        thinking: { type: "string" },
        context: { type: "string" },
        snapshot: { type: "string" },
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

  const runnerKind = parsed.values.runner ?? "mock";
  if (runnerKind !== "mock" && runnerKind !== "pi") {
    io.stderr(`afps run: unknown --runner '${runnerKind}' (mock|pi)\n`);
    return 2;
  }

  let runnerInstance: BundleRunner;
  if (runnerKind === "mock") {
    if (!parsed.values.events) {
      io.stderr("afps run: --runner mock requires --events <path>\n");
      return 2;
    }
    const events = await readEvents(parsed.values.events, io);
    if (!events) return 1;
    runnerInstance = new MockRunner({ events });
  } else {
    const piRunner = buildPiRunner(parsed.values, io);
    if (!piRunner) return 2;
    runnerInstance = piRunner;
  }

  let runContext: RunContextFile = {};
  if (parsed.values.context) {
    try {
      runContext = JSON.parse(await readFile(parsed.values.context, "utf-8")) as RunContextFile;
    } catch (err) {
      io.stderr(`afps run: cannot read context file: ${(err as Error).message}\n`);
      return 1;
    }
  }
  let snapshot: ContextSnapshot | undefined;
  if (parsed.values.snapshot) {
    try {
      snapshot = JSON.parse(await readFile(parsed.values.snapshot, "utf-8")) as ContextSnapshot;
    } catch (err) {
      io.stderr(`afps run: cannot read snapshot file: ${(err as Error).message}\n`);
      return 1;
    }
  }

  const bundleBytes = await readFile(bundlePath);
  const bundle = loadBundleFromBuffer(bundleBytes);

  const context: ExecutionContext = {
    runId: runContext.runId ?? "cli-run",
    input: runContext.input ?? {},
    ...runContext,
  };

  const sink = await buildSink(parsed.values, bundlePath, io);
  if (!sink) return 1;

  const result = await runnerInstance.run({
    bundle,
    context,
    sink,
    contextProvider: new SnapshotContextProvider(snapshot),
  });

  if (parsed.values.output) {
    await writeFile(parsed.values.output, JSON.stringify(result, null, 2) + "\n");
    io.stdout(`→ wrote RunResult to ${parsed.values.output}\n`);
  }
  if (result.error) {
    io.stderr(`afps run: agent finished with error — ${result.error.message}\n`);
    return 1;
  }
  return 0;
}

const VALID_PI_APIS: readonly PiModelApi[] = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "google-generative-ai",
  "mistral-conversations",
];

const VALID_THINKING = ["off", "low", "medium", "high"] as const;

function buildPiRunner(
  values: Record<string, string | boolean | undefined>,
  io: CliIO,
): PiRunner | null {
  const model = values.model as string | undefined;
  const api = values.api as string | undefined;
  const apiKey = (values["api-key"] as string | undefined) ?? process.env.LLM_API_KEY;
  const provider = values.provider as string | undefined;
  const thinking = values.thinking as string | undefined;

  if (!model) {
    io.stderr("afps run --runner pi: --model <id> is required\n");
    return null;
  }
  if (!api) {
    io.stderr("afps run --runner pi: --api <pi-api> is required\n");
    return null;
  }
  if (!VALID_PI_APIS.includes(api as PiModelApi)) {
    io.stderr(
      `afps run --runner pi: unknown --api '${api}' (valid: ${VALID_PI_APIS.join(", ")})\n`,
    );
    return null;
  }
  if (!apiKey) {
    io.stderr("afps run --runner pi: provide --api-key or set LLM_API_KEY\n");
    return null;
  }
  if (thinking && !(VALID_THINKING as readonly string[]).includes(thinking)) {
    io.stderr(
      `afps run --runner pi: unknown --thinking '${thinking}' (valid: ${VALID_THINKING.join(", ")})\n`,
    );
    return null;
  }

  const baseUrl = values["base-url"] as string | undefined;
  return new PiRunner({
    model: { id: model, api: api as PiModelApi, provider, baseUrl },
    apiKey,
    thinkingLevel: (thinking as "off" | "low" | "medium" | "high" | undefined) ?? "medium",
  });
}

async function readEvents(path: string, io: CliIO): Promise<AfpsEvent[] | null> {
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
  const events: AfpsEvent[] = [];
  for (let i = 0; i < raw.length; i++) {
    const parsed = afpsEventSchema.safeParse(raw[i]);
    if (!parsed.success) {
      io.stderr(`afps run: invalid event at index ${i}: ${parsed.error.message}\n`);
      return null;
    }
    events.push(parsed.data);
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
    // --sink=console + --quiet: return a no-op sink
    return {
      onEvent: async () => undefined,
      finalize: async () => undefined,
    };
  }
  return sinks.length === 1 ? sinks[0]! : new CompositeSink(sinks);
}
