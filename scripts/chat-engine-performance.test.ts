// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  compareCellInvariants,
  memoryCheckpoints,
  normalizeFetchRequest,
  parseDotEnvValue,
  percentile,
  summarizeDurations,
  summarizeWaveActivity,
  waitForWorkerExit,
  type MemorySample,
} from "./chat-engine-performance-lib.ts";

describe("chat engine performance observation helpers", () => {
  it("uses nearest-rank percentiles for reproducible latency summaries", () => {
    expect(percentile([40, 10, 30, 20], 0.5)).toBe(20);
    expect(percentile([40, 10, 30, 20], 0.95)).toBe(40);
    expect(summarizeDurations([40, 10, 30, 20])).toEqual({ p50: 20, p95: 40, p99: 40 });
  });

  it("selects the first sample at or after every recovery checkpoint", () => {
    const samples: MemorySample[] = [
      sample(0, 100),
      sample(900, 140),
      sample(1_100, 130),
      sample(31_100, 115),
      sample(61_200, 108),
      sample(121_050, 103),
    ];

    expect(memoryCheckpoints(samples, { waveStartedAtMs: 0, waveEndedAtMs: 1_000 })).toEqual({
      initial: samples[0],
      peak: samples[1],
      end: samples[2],
      after30s: samples[3],
      after60s: samples[4],
      after120s: samples[5],
    });
  });

  it("excludes database startup from wave CPU and event-loop metrics", () => {
    const samples = [
      { ...sample(0, 100), cpuUserMicros: 1, cpuSystemMicros: 2, eventLoopDelayMs: 900 },
      { ...sample(110, 120), cpuUserMicros: 11, cpuSystemMicros: 7, eventLoopDelayMs: 4 },
      { ...sample(160, 130), cpuUserMicros: 31, cpuSystemMicros: 17, eventLoopDelayMs: 6 },
      { ...sample(210, 125), cpuUserMicros: 41, cpuSystemMicros: 22, eventLoopDelayMs: 800 },
    ];

    expect(summarizeWaveActivity(samples, { waveStartedAtMs: 100, waveEndedAtMs: 200 })).toEqual({
      eventLoopDelayMs: { p50: 4, p95: 6, p99: 6 },
      cpu: { userMicros: 30, systemMicros: 15 },
    });
  });

  it("invalidates an A/B cell when model calls or tokens differ without an explanation", () => {
    expect(
      compareCellInvariants(
        { modelCalls: 10, inputTokens: 120, outputTokens: 40 },
        { modelCalls: 11, inputTokens: 120, outputTokens: 40 },
      ),
    ).toEqual({ valid: false, reasons: ["model_calls:10!=11"] });

    expect(
      compareCellInvariants(
        { modelCalls: 10, inputTokens: 120, outputTokens: 40 },
        { modelCalls: 10, inputTokens: 121, outputTokens: 40 },
        "Pi serializes one provider control token",
      ),
    ).toEqual({ valid: true, reasons: ["Pi serializes one provider control token"] });
  });

  it("normalizes URL-style fetch calls made by the Pi MCP client", () => {
    const request = normalizeFetchRequest("http://127.0.0.1:3400/api/mcp/o/org_1", {
      method: "POST",
      headers: { "x-org-id": "org_1" },
      body: "{}",
    });

    expect(request.url).toBe("http://127.0.0.1:3400/api/mcp/o/org_1");
    expect(request.method).toBe("POST");
    expect(request.headers.get("x-org-id")).toBe("org_1");
  });

  it("loads an explicitly named provider key without exposing neighboring env values", () => {
    const contents = [
      "UNRELATED_SECRET=do-not-use",
      'MISTRAL_API_KEY="mistral-test-key"',
      "OPENROUTER_API_KEY=openrouter-test-key",
    ].join("\n");

    expect(parseDotEnvValue(contents, "MISTRAL_API_KEY")).toBe("mistral-test-key");
    expect(parseDotEnvValue(contents, "ABSENT_API_KEY")).toBeNull();
  });

  it("force-stops a benchmark worker that ignores graceful timeout shutdown", async () => {
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const signals: number[] = [];
    const worker = {
      exited,
      kill(signal: number) {
        signals.push(signal);
        if (signal === 9) resolveExit(137);
      },
    };

    await expect(waitForWorkerExit(worker, 5, 5)).rejects.toThrow("benchmark worker exceeded 5 ms");
    expect(signals).toEqual([15, 9]);
  });
});

function sample(elapsedMs: number, rss: number): MemorySample {
  return {
    elapsedMs,
    rss,
    heapUsed: rss / 2,
    external: 1,
    arrayBuffers: 1,
    cpuUserMicros: 0,
    cpuSystemMicros: 0,
    eventLoopDelayMs: 0,
  };
}
