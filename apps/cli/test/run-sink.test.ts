// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the run command's console EventSinks (JSONL + human).
 * Captures stdout/stderr writes via temporary patches — the sinks use
 * raw process.stdout/stderr.write so we intercept at that layer.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createConsoleSink } from "../src/commands/run/sink.ts";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import type { RunResult } from "@appstrate/afps-runtime/runner";

interface CapturedStreams {
  stdout: string;
  stderr: string;
  restore: () => void;
}

function captureStreams(): CapturedStreams {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  (process.stdout as unknown as { write: (c: string | Uint8Array) => boolean }).write = (c) => {
    stdout += typeof c === "string" ? c : new TextDecoder().decode(c);
    return true;
  };
  (process.stderr as unknown as { write: (c: string | Uint8Array) => boolean }).write = (c) => {
    stderr += typeof c === "string" ? c : new TextDecoder().decode(c);
    return true;
  };
  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    restore() {
      (process.stdout as unknown as { write: typeof origOut }).write = origOut;
      (process.stderr as unknown as { write: typeof origErr }).write = origErr;
    },
  } as CapturedStreams;
}

const RUN_ID = "run_sink_test";

function progressEvent(message: string, data?: unknown): RunEvent {
  return { type: "appstrate.progress", timestamp: 0, runId: RUN_ID, message, data } as RunEvent;
}

function emptyResult(): RunResult {
  return {
    memories: [],
    state: null,
    output: null,
    report: "",
    logs: [],
  };
}

describe("createConsoleSink — JSONL mode", () => {
  let streams: CapturedStreams;
  beforeEach(() => {
    streams = captureStreams();
  });
  afterEach(() => streams.restore());

  it("emits one JSON line per event", async () => {
    const sink = createConsoleSink({ json: true });
    await sink.handle(progressEvent("hello"));
    await sink.handle(progressEvent("world"));

    const lines = streams.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed0 = JSON.parse(lines[0]!) as RunEvent;
    const parsed1 = JSON.parse(lines[1]!) as RunEvent;
    expect(parsed0.type).toBe("appstrate.progress");
    expect(parsed0.message).toBe("hello");
    expect(parsed1.message).toBe("world");
  });

  it("emits a terminal appstrate.finalize envelope on finalize", async () => {
    const sink = createConsoleSink({ json: true });
    const result = emptyResult();
    await sink.finalize(result);

    const lines = streams.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as { type: string; result: RunResult };
    expect(parsed.type).toBe("appstrate.finalize");
    expect(parsed.result).toEqual(result);
  });

  it("writes final result to outputPath when provided", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sink-test-"));
    const out = path.join(dir, "result.json");
    const sink = createConsoleSink({ json: true, outputPath: out });
    await sink.finalize({ ...emptyResult(), report: "hello" });
    const read = await fs.readFile(out, "utf8");
    expect(read).toContain('"report": "hello"');
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("createConsoleSink — human mode", () => {
  let streams: CapturedStreams;
  beforeEach(() => {
    streams = captureStreams();
  });
  afterEach(() => streams.restore());

  it("writes progress text to stdout", async () => {
    const sink = createConsoleSink({});
    await sink.handle(progressEvent("doing stuff"));
    expect(streams.stdout).toContain("doing stuff");
  });

  it("writes tool progress with tool name on stdout", async () => {
    const sink = createConsoleSink({});
    await sink.handle(progressEvent("Tool: read_file", { tool: "read_file" }));
    expect(streams.stdout).toContain("read_file");
  });

  it("routes appstrate.error to stderr", async () => {
    const sink = createConsoleSink({});
    await sink.handle({
      type: "appstrate.error",
      timestamp: 0,
      runId: RUN_ID,
      message: "boom",
    } as RunEvent);
    expect(streams.stderr).toContain("boom");
    expect(streams.stdout).not.toContain("boom");
  });

  it("prints run complete on successful finalize", async () => {
    const sink = createConsoleSink({});
    await sink.finalize(emptyResult());
    expect(streams.stdout).toContain("run complete");
  });

  it("prints failure line when result has error", async () => {
    const sink = createConsoleSink({});
    await sink.finalize({ ...emptyResult(), error: { message: "bad" } });
    expect(streams.stdout).toContain("bad");
    expect(streams.stdout).toContain("failed");
  });

  it("formats metric with token counts + cost", async () => {
    const sink = createConsoleSink({});
    await sink.handle({
      type: "appstrate.metric",
      timestamp: 0,
      runId: RUN_ID,
      usage: { input_tokens: 100, output_tokens: 50 },
      cost: 0.0125,
    } as RunEvent);
    expect(streams.stdout).toContain("in=100");
    expect(streams.stdout).toContain("out=50");
    expect(streams.stdout).toContain("0.0125");
  });

  it("remains silent on unmapped events (no stdout, no stderr)", async () => {
    const sink = createConsoleSink({});
    await sink.handle({
      type: "state.set",
      timestamp: 0,
      runId: RUN_ID,
      state: {},
    } as RunEvent);
    expect(streams.stdout).toBe("");
    expect(streams.stderr).toBe("");
  });
});
