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
    output: null,
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
    await sink.finalize({ ...emptyResult(), output: { hello: true } });
    const read = await fs.readFile(out, "utf8");
    expect(read).toContain('"hello": true');
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

  it("writes args line when start event carries args (normal verbosity)", async () => {
    const sink = createConsoleSink({});
    await sink.handle(
      progressEvent("Tool: read_file", {
        tool: "read_file",
        args: { path: "/tmp/x", limit: 10 },
      }),
    );
    expect(streams.stdout).toContain("→ tool: read_file");
    expect(streams.stdout).toContain("args");
    expect(streams.stdout).toContain("path: /tmp/x");
    expect(streams.stdout).toContain("limit: 10");
  });

  it("truncates args at the compact limit (200 chars)", async () => {
    const sink = createConsoleSink({});
    await sink.handle(progressEvent("Tool: t", { tool: "t", args: { data: "x".repeat(500) } }));
    // The truncation marker '...' must appear, and the line must not
    // contain the full 500-char string.
    expect(streams.stdout).toContain("...");
    expect(streams.stdout.includes("x".repeat(500))).toBe(false);
  });

  it("writes a result line on tool_execution_end (success)", async () => {
    const sink = createConsoleSink({});
    await sink.handle(
      progressEvent("Tool result: bash", {
        tool: "bash",
        result: "total 8",
        isError: false,
      }),
    );
    expect(streams.stdout).toContain("✓");
    expect(streams.stdout).toContain("result");
    expect(streams.stdout).toContain("total 8");
  });

  it("writes a result line with ✗ glyph on tool error", async () => {
    const sink = createConsoleSink({});
    await sink.handle(
      progressEvent("Tool error: bash", {
        tool: "bash",
        result: "command not found",
        isError: true,
      }),
    );
    expect(streams.stdout).toContain("✗");
    expect(streams.stdout).toContain("error");
    expect(streams.stdout).toContain("command not found");
  });

  it("collapses multi-line results to a single line in normal mode", async () => {
    const sink = createConsoleSink({});
    await sink.handle(
      progressEvent("Tool result: bash", {
        tool: "bash",
        result: "line1\nline2\nline3",
        isError: false,
      }),
    );
    // Result line must contain ↵ instead of literal newlines so the
    // event prints on one line. There should be exactly one trailing
    // newline (the line terminator).
    const lines = streams.stdout.split("\n").filter((l) => l.includes("result"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("↵");
  });

  it("preserves multi-line results in verbose mode (indented)", async () => {
    const sink = createConsoleSink({ verbosity: "verbose" });
    await sink.handle(
      progressEvent("Tool result: bash", {
        tool: "bash",
        result: "line1\nline2\nline3",
        isError: false,
      }),
    );
    expect(streams.stdout).toContain("line1");
    expect(streams.stdout).toContain("line2");
    expect(streams.stdout).toContain("line3");
    expect(streams.stdout).not.toContain("↵");
  });

  it("pretty-prints args as multi-line JSON in verbose mode", async () => {
    const sink = createConsoleSink({ verbosity: "verbose" });
    await sink.handle(
      progressEvent("Tool: read_file", {
        tool: "read_file",
        args: { path: "/tmp/x", nested: { a: 1 } },
      }),
    );
    expect(streams.stdout).toContain('"path"');
    expect(streams.stdout).toContain('"nested"');
    // Verbose JSON spans multiple lines — at least one indented line.
    expect(streams.stdout).toMatch(/\n {4,}"a": 1/);
  });

  it("suppresses tool name, args, and result in quiet mode", async () => {
    const sink = createConsoleSink({ verbosity: "quiet" });
    await sink.handle(
      progressEvent("Tool: read_file", {
        tool: "read_file",
        args: { path: "/tmp/x" },
      }),
    );
    await sink.handle(
      progressEvent("Tool result: read_file", {
        tool: "read_file",
        result: "data",
        isError: false,
      }),
    );
    expect(streams.stdout).toBe("");
  });

  it("quiet mode still routes appstrate.error to stderr", async () => {
    const sink = createConsoleSink({ verbosity: "quiet" });
    await sink.handle({
      type: "appstrate.error",
      timestamp: 0,
      runId: RUN_ID,
      message: "boom",
    } as RunEvent);
    expect(streams.stderr).toContain("boom");
  });

  it("renders tool with no args and no result as just the name", async () => {
    const sink = createConsoleSink({});
    await sink.handle(progressEvent("Tool: ping", { tool: "ping" }));
    expect(streams.stdout).toContain("→ tool: ping");
    expect(streams.stdout.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("renders the bridge's truncation marker as a human-readable size", async () => {
    const sink = createConsoleSink({});
    await sink.handle(
      progressEvent("Tool result: read_file", {
        tool: "read_file",
        result: { __truncated: true, reason: "size", bytes: 9999, limit: 2048 },
        isError: false,
      }),
    );
    expect(streams.stdout).toContain("truncated");
    expect(streams.stdout).toContain("9.8 KB");
    expect(streams.stdout).not.toContain("__truncated");
  });

  it("routes appstrate.error to stderr with ⚠ (warning) glyph, not ✗", async () => {
    // appstrate.error is mid-run advisory (Pi can recover); the
    // terminal `[run failed]` is the only fatal indicator. Using ✗
    // here would visually contradict a successful finalize that
    // follows.
    const sink = createConsoleSink({});
    await sink.handle({
      type: "appstrate.error",
      timestamp: 0,
      runId: RUN_ID,
      message: "boom",
    } as RunEvent);
    expect(streams.stderr).toContain("boom");
    expect(streams.stderr).toContain("⚠");
    expect(streams.stderr).not.toContain("✗");
    expect(streams.stdout).not.toContain("boom");
  });

  it("renders MCP envelope results without leaking the JSON framing", async () => {
    const sink = createConsoleSink({});
    await sink.handle(
      progressEvent("Tool result: log", {
        tool: "log",
        result: { content: [{ type: "text", text: "Logged [info]: hello" }] },
        isError: false,
      }),
    );
    expect(streams.stdout).toContain("Logged [info]: hello");
    expect(streams.stdout).not.toContain('"content"');
    expect(streams.stdout).not.toContain('"type":"text"');
  });

  it("renders the bridge's truncation marker in human units", async () => {
    const sink = createConsoleSink({});
    await sink.handle(
      progressEvent("Tool result: read_file", {
        tool: "read_file",
        result: {
          __truncated: true,
          reason: "size",
          bytes: 12244,
          limit: 2048,
          preview: JSON.stringify({
            content: [{ type: "text", text: "Logged [info]: deep content" }],
          }),
        },
        isError: false,
      }),
    );
    expect(streams.stdout).toContain("truncated");
    // 12244 B = 11.96 KB → "12 KB" in our formatter (≥10 → integer).
    expect(streams.stdout).toContain("12 KB");
    expect(streams.stdout).toContain("Logged [info]: deep content");
    expect(streams.stdout).not.toContain('"__truncated"');
    expect(streams.stdout).not.toContain('\\"content\\"');
  });

  it("shows short toolCallId suffix in normal mode for parallel correlation", async () => {
    const sink = createConsoleSink({});
    await sink.handle(
      progressEvent("Tool: bash", {
        tool: "bash",
        args: { command: "ls" },
        toolCallId: "call_abcd1234efgh5678",
      }),
    );
    expect(streams.stdout).toContain("→ tool: bash");
    // Last-8 short form is visible in both normal and verbose modes —
    // the long-form id never leaks.
    expect(streams.stdout).toContain("#efgh5678");
    expect(streams.stdout).not.toContain("call_abcd");
  });

  it("omits toolCallId suffix entirely when Pi did not forward one", async () => {
    const sink = createConsoleSink({});
    await sink.handle(
      progressEvent("Tool: bash", {
        tool: "bash",
        args: { command: "ls" },
      }),
    );
    expect(streams.stdout).toContain("→ tool: bash");
    expect(streams.stdout).not.toContain("#");
  });

  it("appends short toolCallId suffix (last 8 chars) in verbose mode", async () => {
    const sink = createConsoleSink({ verbosity: "verbose" });
    await sink.handle(
      progressEvent("Tool: bash", {
        tool: "bash",
        args: { command: "ls" },
        toolCallId: "call_abcd1234efgh5678",
      }),
    );
    expect(streams.stdout).toContain("→ tool: bash");
    expect(streams.stdout).toContain("#efgh5678");
    // Long-form id should NOT leak.
    expect(streams.stdout).not.toContain("call_abcd");
  });

  it("matches start and end events via toolCallId in verbose mode", async () => {
    const sink = createConsoleSink({ verbosity: "verbose" });
    await sink.handle(
      progressEvent("Tool: provider_call", {
        tool: "provider_call",
        args: { url: "/foo" },
        toolCallId: "call_aaaaaaaaaaaaaaaa",
      }),
    );
    await sink.handle(
      progressEvent("Tool: provider_call", {
        tool: "provider_call",
        args: { url: "/bar" },
        toolCallId: "call_bbbbbbbbbbbbbbbb",
      }),
    );
    await sink.handle(
      progressEvent("Tool result: provider_call", {
        tool: "provider_call",
        result: "ok",
        isError: false,
        toolCallId: "call_aaaaaaaaaaaaaaaa",
      }),
    );
    // The 'aaaa...' result line must carry the same suffix as its start line.
    const lines = streams.stdout.split("\n").filter((l) => l.includes("aaaaaaaa"));
    expect(lines.length).toBe(2);
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
      type: "@my-org/audit.logged",
      timestamp: 0,
      runId: RUN_ID,
      actor: "u_1",
    } as RunEvent);
    expect(streams.stdout).toBe("");
    expect(streams.stderr).toBe("");
  });

  it("renders report.appended content as a stdout line", async () => {
    const sink = createConsoleSink({});
    await sink.handle({
      type: "report.appended",
      timestamp: 0,
      runId: RUN_ID,
      content: "## Section header",
    } as RunEvent);
    expect(streams.stdout).toContain("## Section header");
  });

  it("trims double newlines on report.appended (no extra blank line)", async () => {
    const sink = createConsoleSink({});
    await sink.handle({
      type: "report.appended",
      timestamp: 0,
      runId: RUN_ID,
      content: "trailing newline\n",
    } as RunEvent);
    // Exactly one newline at the end — the sink must not double it.
    expect(streams.stdout).toBe("trailing newline\n");
  });
});

// ---------------------------------------------------------------------------
// writeStdout injection — bridge anti-recursion contract
// ---------------------------------------------------------------------------
//
// The CLI's `run.ts` installs an `attachStdoutBridge` around the runner's
// sink. The bridge intercepts `process.stdout.write` to capture canonical
// events emitted by system tools as JSONL. Without `writeStdout`, the
// console sink would write `--json` envelopes directly to stdout and the
// bridge would re-aspirate them, dispatching every event twice. The
// `writeStdout` injection lets `run.ts` route console output through
// `bridge.writeRaw`, bypassing the interceptor.

describe("createConsoleSink — writeStdout injection", () => {
  it("routes JSONL emissions through the injected writer (not process.stdout)", async () => {
    const captured: string[] = [];
    const streams = captureStreams();
    try {
      const sink = createConsoleSink({
        json: true,
        writeStdout: (chunk) => {
          captured.push(chunk);
        },
      });
      await sink.handle(progressEvent("hello"));
      await sink.finalize(emptyResult());
      // Two writes captured by the injected writer; nothing leaked to
      // the actual process.stdout (the captureStreams patch confirms it).
      expect(captured).toHaveLength(2);
      expect(captured[0]!.includes('"hello"')).toBe(true);
      expect(captured[1]!.includes("appstrate.finalize")).toBe(true);
      expect(streams.stdout).toBe("");
    } finally {
      streams.restore();
    }
  });

  it("routes human-mode emissions through the injected writer", async () => {
    const captured: string[] = [];
    const streams = captureStreams();
    try {
      const sink = createConsoleSink({
        writeStdout: (chunk) => {
          captured.push(chunk);
        },
      });
      await sink.handle(progressEvent("doing stuff"));
      await sink.finalize(emptyResult());
      expect(captured.join("")).toContain("doing stuff");
      expect(captured.join("")).toContain("run complete");
      expect(streams.stdout).toBe("");
    } finally {
      streams.restore();
    }
  });

  it("keeps appstrate.error on real stderr (writeStdout is stdout-only)", async () => {
    const captured: string[] = [];
    const streams = captureStreams();
    try {
      const sink = createConsoleSink({
        writeStdout: (chunk) => {
          captured.push(chunk);
        },
      });
      await sink.handle({
        type: "appstrate.error",
        timestamp: 0,
        runId: RUN_ID,
        message: "boom",
      } as RunEvent);
      // The injected writer is stdout-scoped; errors still hit real stderr.
      expect(captured).toHaveLength(0);
      expect(streams.stderr).toContain("boom");
    } finally {
      streams.restore();
    }
  });
});
