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
 */

import type { EventSink } from "@appstrate/afps-runtime/interfaces";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import type { RunResult } from "@appstrate/afps-runtime/runner";

export interface SinkOptions {
  /** Emit JSONL on stdout. When false, human-readable output is used. */
  json?: boolean;
  /** Write the final RunResult JSON to this path. Optional. */
  outputPath?: string;
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

export function createConsoleSink(opts: SinkOptions = {}): EventSink {
  if (opts.json) return createJsonlSink(opts);
  return createHumanSink(opts);
}

function createJsonlSink(opts: SinkOptions): EventSink {
  return {
    async handle(event: RunEvent): Promise<void> {
      process.stdout.write(JSON.stringify(event) + "\n");
    },
    async finalize(result: RunResult): Promise<void> {
      // Emit finalize as a terminal envelope so downstream jq pipelines
      // can pick the boundary without process-exit polling.
      process.stdout.write(JSON.stringify({ type: "appstrate.finalize", result }) + "\n");
      await writeOutputIfRequested(opts.outputPath, result);
    },
  };
}

function createHumanSink(opts: SinkOptions): EventSink {
  return {
    async handle(event: RunEvent): Promise<void> {
      switch (event.type) {
        case "appstrate.progress": {
          const msg = String(event.message ?? "");
          const data = event.data as { tool?: string } | undefined;
          if (data?.tool) {
            process.stdout.write(cyan(`→ tool: ${data.tool}\n`));
          } else if (msg) {
            // Prepend `→` for visual consistency with the rest of the
            // CLI output ("→ running ...", "→ tool: ..."). Messages
            // that already carry a leading glyph (e.g. emitted by a
            // third-party tool) are left untouched.
            const glyphed = /^[→✓✗⚠]/.test(msg) ? msg : `→ ${msg}`;
            process.stdout.write(glyphed.endsWith("\n") ? glyphed : glyphed + "\n");
          }
          return;
        }
        case "appstrate.error": {
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
          process.stdout.write(dim(`∑ tokens in=${input} out=${output}  $${cost.toFixed(4)}\n`));
          return;
        }
        case "memory.added": {
          process.stdout.write(yellow(`+ memory: ${String(event.content ?? "")}\n`));
          return;
        }
        case "output.emitted": {
          process.stdout.write(green(`✓ output: ${JSON.stringify(event.data ?? {})}\n`));
          return;
        }
        default: {
          // Be quiet about low-signal events (log.written, report.appended,
          // pinned.set) by default — JSONL mode exposes them fully.
          return;
        }
      }
    },
    async finalize(result: RunResult): Promise<void> {
      const line = result.error
        ? red(`\n[run failed] ${result.error.message}\n`)
        : green(`\n[run complete]\n`);
      process.stdout.write(line);
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
