// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the CLI's stdout-JSONL bridge wiring.
 *
 * Replays the exact composition `apps/cli/src/commands/run.ts` builds at
 * runtime — `attachStdoutBridge` around a `CompositeSink([consoleSink,
 * httpSink])`, with the console sink's `writeStdout` routed through
 * `bridge.writeRaw` — and asserts the contracts that matter end-to-end:
 *
 *   1. **Tool-event capture (online).** A canonical event written by a
 *      system tool to `process.stdout` reaches the HTTP sink, the
 *      finalize body merges the bridge's aggregate so `result.output`
 *      / `result.report` are non-empty.
 *   2. **Tool-event capture (offline).** Without an HTTP sink, the
 *      console sink's `--output <file>` mode writes a finalize JSON
 *      whose `result.output` matches what the tool emitted.
 *   3. **Anti-recursion.** In `--json` mode, the console sink emits
 *      JSONL on stdout. Without `writeStdout` routing through
 *      `bridge.writeRaw`, the bridge would re-aspirate every line and
 *      dispatch each event a second time. The wiring under test must
 *      produce exactly one delivery per emitted event.
 *
 * No actual runner / LLM / Pi SDK is started — these tests stand in for
 * the runner by directly writing the JSONL events that `@appstrate/output`
 * and `@appstrate/report` would write at runtime, then driving finalize.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  attachStdoutBridge,
  CompositeSink,
  type StdoutBridgeHandle,
} from "@appstrate/afps-runtime/sinks";
import type { EventSink } from "@appstrate/afps-runtime/interfaces";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import type { RunResult } from "@appstrate/afps-runtime/runner";
import { emptyRunResult } from "@appstrate/afps-runtime/runner";
import { createConsoleSink } from "../src/commands/run/sink.ts";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const RUN_ID = "run_cli_bridge_test";

interface FakeStdout {
  write: NodeJS.WritableStream["write"];
  writes: string[];
}

function makeFakeStdout(): FakeStdout {
  const writes: string[] = [];
  const decoder = new TextDecoder();
  const write = (chunk: string | Uint8Array, ..._rest: unknown[]): boolean => {
    writes.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
    return true;
  };
  return { write: write as unknown as NodeJS.WritableStream["write"], writes };
}

interface RecordingHttpSink {
  sink: EventSink;
  events: RunEvent[];
  finalized: RunResult | null;
}

function makeRecordingHttpSink(): RecordingHttpSink {
  const events: RunEvent[] = [];
  let finalized: RunResult | null = null;
  const sink: EventSink = {
    async handle(event) {
      events.push(event);
    },
    async finalize(result) {
      finalized = result;
    },
  };
  return {
    sink,
    events,
    get finalized() {
      return finalized;
    },
  } as RecordingHttpSink;
}

/**
 * Build the same sink composition `run.ts` wires at runtime, with the
 * stdout-bridge injected against a fake stdout (so tests don't intercept
 * the real `process.stdout`). Returns the handle exposed to the runner
 * (`sink`) plus all the inspectable parts.
 */
interface CliWiring {
  sink: EventSink;
  bridge: StdoutBridgeHandle;
  http: RecordingHttpSink | null;
  stdout: FakeStdout;
}

function buildCliWiring(opts: {
  json?: boolean;
  outputPath?: string;
  withReporting: boolean;
}): CliWiring {
  const stdout = makeFakeStdout();
  const http = opts.withReporting ? makeRecordingHttpSink() : null;

  // Trampoline: console sink needs `writeStdout`, bridge needs the
  // composite sink. Resolve via late binding — same pattern as run.ts.
  let writeStdout: (chunk: string) => void = (chunk: string): void => {
    stdout.write.call(null as never, chunk);
  };
  const consoleSink = createConsoleSink({
    json: opts.json,
    outputPath: opts.outputPath,
    writeStdout: (chunk) => writeStdout(chunk),
  });
  const composite: EventSink = http ? new CompositeSink([consoleSink, http.sink]) : consoleSink;
  const bridge = attachStdoutBridge({ sink: composite, runId: RUN_ID, stdout });
  writeStdout = (chunk) => {
    bridge.writeRaw(chunk);
  };
  return { sink: bridge.sink, bridge, http, stdout };
}

/** Yield enough microtasks for fire-and-forget bridge dispatches to settle. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Simulate a system tool emission (the legacy stdout-JSONL protocol).
 * Same shape `@appstrate/output` and `@appstrate/report` write at
 * runtime: object stamped with `timestamp` + `runId`, terminated by `\n`.
 */
function emitFromTool(stdout: FakeStdout, event: Record<string, unknown>): void {
  stdout.write.call(
    null as never,
    JSON.stringify({ ...event, timestamp: Date.now(), runId: RUN_ID }) + "\n",
  );
}

// ---------------------------------------------------------------------------
// Online mode (--report) — events propagate to the HTTP sink, finalize
// body carries the merged aggregate.
// ---------------------------------------------------------------------------

describe("CLI wiring — online (HttpSink composed with ConsoleSink)", () => {
  it("propagates output.emitted from stdout-JSONL to the HTTP sink", async () => {
    const wiring = buildCliWiring({ withReporting: true });

    emitFromTool(wiring.stdout, { type: "output.emitted", data: { answer: 42 } });
    await flushMicrotasks();

    expect(wiring.http!.events).toHaveLength(1);
    const ev = wiring.http!.events[0]!;
    expect(ev.type).toBe("output.emitted");
    expect((ev as unknown as { data: { answer: number } }).data.answer).toBe(42);
    // The bridge re-stamped runId, even though the tool wrote the same value.
    expect((ev as { runId: string }).runId).toBe(RUN_ID);

    wiring.bridge.restore();
  });

  it("propagates report.appended to the HTTP sink", async () => {
    const wiring = buildCliWiring({ withReporting: true });

    emitFromTool(wiring.stdout, { type: "report.appended", content: "## Heading" });
    emitFromTool(wiring.stdout, { type: "report.appended", content: "body line" });
    await flushMicrotasks();

    expect(wiring.http!.events).toHaveLength(2);
    expect(wiring.http!.events.map((e) => e.type)).toEqual(["report.appended", "report.appended"]);
  });

  it("merges the bridge aggregate into the finalize body (output + report)", async () => {
    const wiring = buildCliWiring({ withReporting: true });

    emitFromTool(wiring.stdout, { type: "output.emitted", data: { ok: true } });
    emitFromTool(wiring.stdout, { type: "report.appended", content: "all done" });
    await flushMicrotasks();

    // Runner finalises with its OWN (incomplete) result — the bridge
    // must merge the aggregated output/report into the payload sent
    // to the HTTP sink.
    await wiring.sink.finalize({ ...emptyRunResult(), status: "success", durationMs: 42 });

    const final = wiring.http!.finalized!;
    expect(final.status).toBe("success");
    expect(final.durationMs).toBe(42);
    expect(final.output).toEqual({ ok: true });
    expect(final.report).toBe("all done");
  });

  it("ignores foreign JSON written to stdout by subprocesses", async () => {
    const wiring = buildCliWiring({ withReporting: true });

    // A subprocess like `npm --json` could legitimately print this.
    wiring.stdout.write.call(null as never, '{"type":"npm.audit","vulnerabilities":0}\n');
    await flushMicrotasks();

    expect(wiring.http!.events).toHaveLength(0);
    // The line passed through to the (fake) original stdout untouched.
    expect(wiring.stdout.writes.some((w) => w.includes("npm.audit"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// --json anti-recursion — the console sink's JSONL output must NOT be
// re-aspirated by the bridge.
// ---------------------------------------------------------------------------

describe("CLI wiring — --json anti-recursion", () => {
  it("never duplicates events when consoleSink writes them as JSONL", async () => {
    const wiring = buildCliWiring({ json: true, withReporting: true });

    // One emission from a system tool. The bridge dispatches it to
    // composite → console (--json prints it on stdout) + http (records).
    // Without `writeStdout` routing through `bridge.writeRaw`, the
    // console sink's stdout write would be re-parsed and dispatched a
    // second time → the http sink would record the same event twice.
    emitFromTool(wiring.stdout, { type: "output.emitted", data: { x: 1 } });
    await flushMicrotasks();
    // Allow the cascading dispatch chain a few extra microtasks to
    // surface any duplication.
    await flushMicrotasks();

    expect(wiring.http!.events).toHaveLength(1);
    expect((wiring.http!.events[0] as unknown as { data: { x: number } }).data.x).toBe(1);

    // The console sink wrote the JSON envelope to stdout via the
    // bridge's escape hatch — visible on the fake stdout, not parsed.
    const allWrites = wiring.stdout.writes.join("");
    expect(allWrites).toContain('"output.emitted"');

    wiring.bridge.restore();
  });

  it("never duplicates the finalize envelope on stdout-JSONL", async () => {
    const wiring = buildCliWiring({ json: true, withReporting: true });

    await wiring.sink.finalize({ ...emptyRunResult(), status: "success" });
    await flushMicrotasks();
    await flushMicrotasks();

    // HTTP sink received exactly one terminal finalize.
    expect(wiring.http!.finalized).not.toBeNull();
    // Console sink wrote one `appstrate.finalize` envelope to stdout.
    // (Note: `appstrate.finalize` is NOT canonical, so even if the
    // bridge tried to parse it, isStdoutEventLine would reject it —
    // but the writeRaw path is still the load-bearing guarantee.)
    const finalizeOccurrences = wiring.stdout.writes.filter((w) =>
      w.includes("appstrate.finalize"),
    );
    expect(finalizeOccurrences).toHaveLength(1);

    wiring.bridge.restore();
  });
});

// ---------------------------------------------------------------------------
// Offline mode (no --report) — bridge still aggregates, --output writes
// the merged result.
// ---------------------------------------------------------------------------

describe("CLI wiring — offline (no HttpSink)", () => {
  it("--output writes a result.json whose output matches the tool's emission", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-bridge-offline-"));
    const outPath = path.join(dir, "result.json");
    try {
      const wiring = buildCliWiring({ outputPath: outPath, withReporting: false });

      emitFromTool(wiring.stdout, { type: "output.emitted", data: { offline: true } });
      emitFromTool(wiring.stdout, { type: "report.appended", content: "offline run done" });
      await flushMicrotasks();

      // Runner's terminal payload is empty — the bridge's aggregate is
      // what makes `result.output` / `result.report` non-null on disk.
      await wiring.sink.finalize({ ...emptyRunResult(), status: "success" });

      const written = await fs.readFile(outPath, "utf8");
      const parsed = JSON.parse(written) as RunResult;
      expect(parsed.status).toBe("success");
      expect(parsed.output).toEqual({ offline: true });
      expect(parsed.report).toBe("offline run done");

      wiring.bridge.restore();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("strict matcher rejects malformed canonical events (no aggregate poison)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-bridge-malformed-"));
    const outPath = path.join(dir, "result.json");
    try {
      const wiring = buildCliWiring({ outputPath: outPath, withReporting: false });

      // Malformed: `output.emitted` requires `data` to be present.
      wiring.stdout.write.call(null as never, '{"type":"output.emitted"}\n');
      // Valid: gets through.
      emitFromTool(wiring.stdout, { type: "output.emitted", data: { real: true } });
      await flushMicrotasks();

      await wiring.sink.finalize({ ...emptyRunResult(), status: "success" });

      const parsed = JSON.parse(await fs.readFile(outPath, "utf8")) as RunResult;
      expect(parsed.output).toEqual({ real: true });

      wiring.bridge.restore();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Bridge teardown — `restore()` removes the stdout interceptor.
// ---------------------------------------------------------------------------

describe("CLI wiring — bridge teardown", () => {
  it("after restore(), tool emissions no longer reach the sink", async () => {
    const wiring = buildCliWiring({ withReporting: true });

    emitFromTool(wiring.stdout, { type: "output.emitted", data: { before: true } });
    await flushMicrotasks();
    expect(wiring.http!.events).toHaveLength(1);

    wiring.bridge.restore();

    emitFromTool(wiring.stdout, { type: "output.emitted", data: { after: true } });
    await flushMicrotasks();
    expect(wiring.http!.events).toHaveLength(1); // unchanged
  });
});
