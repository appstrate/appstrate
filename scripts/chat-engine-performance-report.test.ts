// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  aggregatePerformanceObservations,
  bootstrapMedianInterval,
  type ReportObservation,
} from "./chat-engine-performance-report-lib.ts";

describe("chat engine performance report", () => {
  it("produces a deterministic 95 percent bootstrap interval", () => {
    const first = bootstrapMedianInterval([10, 20, 30, 40, 50], 2_000, 42);
    const second = bootstrapMedianInterval([10, 20, 30, 40, 50], 2_000, 42);

    expect(first).toEqual(second);
    expect(first.estimate).toBe(30);
    expect(first.low).toBeLessThanOrEqual(first.estimate);
    expect(first.high).toBeGreaterThanOrEqual(first.estimate);
  });

  it("keeps raw references and computes the marginal RSS slope by repetition", () => {
    const observations = [
      observation("ai-sdk", 10, 1, 100),
      observation("ai-sdk", 100, 1, 190),
      observation("ai-sdk", 10, 2, 120),
      observation("ai-sdk", 100, 2, 300),
    ];

    const report = aggregatePerformanceObservations(observations);

    expect(report.groups).toHaveLength(2);
    expect(report.groups[0]?.observations).toEqual([
      "raw-ai-sdk-10-1.json",
      "raw-ai-sdk-10-2.json",
    ]);
    expect(report.groups[0]?.metrics.memory.initial.rssBytes.estimate).toBe(50);
    expect(report.groups[0]?.metrics.memory.after120s).toBeNull();
    expect(report.groups[0]?.metrics.eventLoopDelayP95Ms.estimate).toBe(2);
    expect(report.groups[0]?.metrics.cpuUserMicros.estimate).toBe(20);
    expect(report.memorySlopes[0]).toMatchObject({
      engine: "ai-sdk",
      fromConcurrency: 10,
      toConcurrency: 100,
      pairedRepetitions: 2,
      rssBytesPerChat: { estimate: 1.5 },
    });
  });
});

function observation(
  engine: "ai-sdk" | "pi",
  concurrency: number,
  repetition: number,
  peakRss: number,
): ReportObservation {
  return {
    source: `raw-${engine}-${concurrency}-${repetition}.json`,
    value: {
      schemaVersion: 1,
      benchmark: "controlled",
      timing: { waveStartedAtMs: 100, waveEndedAtMs: 200 },
      samples: [activitySample(110, 10, 2), activitySample(210, 30, 900)],
      cell: { engine, form: "S", profile: "warm", concurrency, repetition },
      memory: { initial: { rss: 50 }, peak: { rss: peakRss }, end: { rss: 75 } },
      eventLoopDelayMs: { p95: 4 },
      latency: {
        firstTokenMs: { p95: 10 },
        totalMs: { p95: 20 },
        throughputChatsPerSecond: 5,
      },
      outcomes: {
        requested: concurrency,
        completed: concurrency,
        rateLimited: 0,
        serverErrors: 0,
        incompleteStreams: 0,
        markerFailures: 0,
      },
      usage: { modelCalls: concurrency, toolCalls: 0, inputTokens: 1, outputTokens: 1 },
      persistence: { messageCount: 1, structuredPartCount: 1, usageRows: 1 },
      continuity: { complete: true, markerValid: true },
      isolation: { foreignSessionRejected: true },
    },
  };
}

function activitySample(elapsedMs: number, cpuUserMicros: number, eventLoopDelayMs: number) {
  return {
    elapsedMs,
    rss: 1,
    heapUsed: 1,
    external: 1,
    arrayBuffers: 1,
    cpuUserMicros,
    cpuSystemMicros: cpuUserMicros / 2,
    eventLoopDelayMs,
  };
}
