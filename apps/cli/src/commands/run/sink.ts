// SPDX-License-Identifier: Apache-2.0

/**
 * Console EventSinks for `appstrate run`.
 *
 * Two modes:
 *   - JSONL (`--json`): one RunEvent per line on stdout, finalize event
 *     last. Composable with `jq` and other JSONL tools.
 *   - Human (default): formatted line per event category, summary at end.
 *     Colours via ANSI escapes — disabled automatically when stdout is
 *     not a TTY or when the user sets `NO_COLOR` (standard contract).
 *
 * The sinks never touch the network and swallow no errors silently —
 * any thrown exception bubbles up to the run command's top-level handler.
 *
 * **`writeStdout` injection.** All stdout output is routed through the
 * caller-supplied `writeStdout` (defaulting to `process.stdout.write`).
 * The `appstrate run` command installs a stdout-JSONL bridge around the
 * runner's sink to capture canonical events emitted by system tools
 * via `process.stdout.write(JSON+\n)` — without `writeStdout`, this
 * sink's JSONL mode would re-emit canonical events directly to stdout
 * and the bridge would re-aspirate them, dispatching every event a
 * second time. Routing through the bridge's `writeRaw` escape hatch
 * bypasses the interceptor and breaks the loop.
 */

import type { EventSink } from "@appstrate/afps-runtime/interfaces";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import type { RunResult } from "@appstrate/afps-runtime/runner";

export interface SinkOptions {
  /** Emit JSONL on stdout. When false, human-readable output is used. */
  json?: boolean;
  /** Write the final RunResult JSON to this path. Optional. */
  outputPath?: string;
  /**
   * Writer used for all stdout output. Defaults to
   * `process.stdout.write`. The CLI passes the stdout-bridge's
   * `writeRaw` so JSONL emissions bypass the bridge's interceptor and
   * don't recurse through the tool-event parser. See module docstring
   * for the full rationale.
   */
  writeStdout?: (chunk: string) => void;
}

const USE_COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function colorise(code: string, text: string): string {
  return USE_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;
}
const dim = (s: string) => colorise("2", s);
const red = (s: string) => colorise("31", s);
const green = (s: string) => colorise("32", s);
const yellow = (s: string) => colorise("33", s);
const cyan = (s: string) => colorise("36", s);

const defaultWriteStdout = (chunk: string): void => {
  process.stdout.write(chunk);
};

export function createConsoleSink(opts: SinkOptions = {}): EventSink {
  const writeStdout = opts.writeStdout ?? defaultWriteStdout;
  if (opts.json) return createJsonlSink(opts, writeStdout);
  return createHumanSink(opts, writeStdout);
}

function createJsonlSink(opts: SinkOptions, writeStdout: (chunk: string) => void): EventSink {
  return {
    async handle(event: RunEvent): Promise<void> {
      writeStdout(JSON.stringify(event) + "\n");
    },
    async finalize(result: RunResult): Promise<void> {
      // Emit finalize as a terminal envelope so downstream jq pipelines
      // can pick the boundary without process-exit polling.
      writeStdout(JSON.stringify({ type: "appstrate.finalize", result }) + "\n");
      await writeOutputIfRequested(opts.outputPath, result);
    },
  };
}

function createHumanSink(opts: SinkOptions, writeStdout: (chunk: string) => void): EventSink {
  return {
    async handle(event: RunEvent): Promise<void> {
      switch (event.type) {
        case "appstrate.progress": {
          const msg = String(event.message ?? "");
          const data = event.data as { tool?: string } | undefined;
          if (data?.tool) {
            writeStdout(cyan(`→ tool: ${data.tool}\n`));
          } else if (msg) {
            // Prepend `→` for visual consistency with the rest of the
            // CLI output ("→ running ...", "→ tool: ..."). Messages
            // that already carry a leading glyph (e.g. emitted by a
            // third-party tool) are left untouched.
            const glyphed = /^[→✓✗⚠]/.test(msg) ? msg : `→ ${msg}`;
            writeStdout(glyphed.endsWith("\n") ? glyphed : glyphed + "\n");
          }
          return;
        }
        case "appstrate.error": {
          // stderr bypasses the stdout bridge entirely — no need to
          // route through `writeStdout`.
          process.stderr.write(red(`✗ ${event.message ?? "error"}\n`));
          return;
        }
        case "appstrate.metric": {
          // Print only the terminal metric (at end of run). Too noisy
          // mid-run otherwise.
          const u = event.usage as
            | {
                input_tokens?: number;
                output_tokens?: number;
                cache_creation_input_tokens?: number;
                cache_read_input_tokens?: number;
              }
            | undefined;
          const cost = typeof event.cost === "number" ? event.cost : 0;
          const input = u?.input_tokens ?? 0;
          const output = u?.output_tokens ?? 0;
          writeStdout(dim(`∑ tokens in=${input} out=${output}  $${cost.toFixed(4)}\n`));
          return;
        }
        case "memory.added": {
          writeStdout(yellow(`+ memory: ${String(event.content ?? "")}\n`));
          return;
        }
        case "output.emitted": {
          writeStdout(green(`✓ output: ${JSON.stringify(event.data ?? {})}\n`));
          return;
        }
        case "report.appended": {
          // Surface the human-readable report content — same channel
          // as `output.emitted` so users can see what the agent wrote
          // without parsing JSONL. One line per emit, no prefix glyph
          // (the content is the message).
          const content = String(event.content ?? "");
          if (content.length > 0) {
            writeStdout(content.endsWith("\n") ? content : content + "\n");
          }
          return;
        }
        default: {
          // Be quiet about low-signal events (log.written, pinned.set)
          // by default — JSONL mode exposes them fully.
          return;
        }
      }
    },
    async finalize(result: RunResult): Promise<void> {
      const line = result.error
        ? red(`\n[run failed] ${result.error.message}\n`)
        : green(`\n[run complete]\n`);
      writeStdout(line);
      await writeOutputIfRequested(opts.outputPath, result);
    },
  };
}

async function writeOutputIfRequested(
  outputPath: string | undefined,
  result: RunResult,
): Promise<void> {
  if (!outputPath) return;
  const fs = await import("node:fs/promises");
  await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");
}
