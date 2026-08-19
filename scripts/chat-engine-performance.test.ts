// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  benchmarkHistoryToolPart,
  benchmarkWorkerCommand,
  buildPiTurnTimeline,
  completedTurnHasUsage,
  defaultSubscriptionModel,
  compareCellInvariants,
  memoryCheckpoints,
  normalizeFetchRequest,
  parseDotEnvValue,
  percentile,
  postgresCellDatabase,
  repetitionNumbers,
  publishedObservationName,
  summarizeDurations,
  summarizeCpuProfileWindow,
  summarizeChatTurnMilestones,
  summarizePiLifecycle,
  summarizePiPromptMilestones,
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

  it("aggregates Pi lifecycle stages and their per-turn pre-prompt total", () => {
    expect(
      summarizePiLifecycle([
        { turnId: "turn-a", stage: "mcpTools", durationMs: 10 },
        { turnId: "turn-a", stage: "modelRuntimeCreate", durationMs: 20 },
        { turnId: "turn-b", stage: "mcpTools", durationMs: 30 },
        { turnId: "turn-b", stage: "modelRuntimeCreate", durationMs: 40 },
      ]),
    ).toEqual({
      sampleCount: 2,
      stagesMs: {
        mcpTools: { p50: 10, p95: 30, p99: 30 },
        modelRuntimeCreate: { p50: 20, p95: 40, p99: 40 },
      },
      prePromptTotalMs: { p50: 30, p95: 70, p99: 70 },
    });
  });

  it("aggregates Pi prompt milestones as absolute offsets from prompt start", () => {
    expect(
      summarizePiPromptMilestones([
        { turnId: "turn-a", milestone: "beforeAgentStart", elapsedMs: 5 },
        { turnId: "turn-a", milestone: "providerRequest", elapsedMs: 20 },
        { turnId: "turn-b", milestone: "beforeAgentStart", elapsedMs: 7 },
        { turnId: "turn-b", milestone: "providerRequest", elapsedMs: 30 },
      ]),
    ).toEqual({
      sampleCount: 2,
      milestonesMs: {
        beforeAgentStart: { p50: 5, p95: 7, p99: 7 },
        providerRequest: { p50: 20, p95: 30, p99: 30 },
      },
    });
  });

  it("aggregates common chat milestones as absolute offsets from request handling", () => {
    expect(
      summarizeChatTurnMilestones([
        { turnId: "turn-a", milestone: "bodyParsed", elapsedMs: 2 },
        { turnId: "turn-a", milestone: "engineDispatch", elapsedMs: 40 },
        { turnId: "turn-b", milestone: "bodyParsed", elapsedMs: 3 },
        { turnId: "turn-b", milestone: "engineDispatch", elapsedMs: 60 },
      ]),
    ).toEqual({
      sampleCount: 2,
      milestonesMs: {
        bodyParsed: { p50: 2, p95: 3, p99: 3 },
        engineDispatch: { p50: 40, p95: 60, p99: 60 },
      },
    });
  });

  it("builds an additive Pi timeline from timestamps belonging to the same turn", () => {
    expect(
      buildPiTurnTimeline({
        turnId: "turn-a",
        requestStartedAt: 100,
        engineEnteredAt: 140,
        promptStartedAt: 200,
        firstTextAt: 230,
        clientFirstTokenAt: 232,
        lifecycleTotalMs: 50,
      }),
    ).toEqual({
      turnId: "turn-a",
      routeToEngineMs: 40,
      engineToPromptMs: 60,
      measuredLifecycleMs: 50,
      unmeasuredEngineSetupMs: 10,
      promptToFirstTextMs: 30,
      firstTextToClientMs: 2,
      requestToClientFirstTokenMs: 132,
    });
  });

  it("builds a worker command with an optional cell-specific CPU profile", () => {
    expect(
      benchmarkWorkerCommand({
        executable: "/usr/bin/bun",
        script: "/work/chat-engine-performance.ts",
        cpuProfile: { directory: "/work/artifacts/cpu", name: "pi-c10.cpuprofile" },
      }),
    ).toEqual([
      "/usr/bin/bun",
      "--cpu-prof",
      "--cpu-prof-dir=/work/artifacts/cpu",
      "--cpu-prof-name=pi-c10.cpuprofile",
      "/work/chat-engine-performance.ts",
      "--worker",
    ]);
  });

  it("derives one isolated PostgreSQL database per benchmark cell", () => {
    expect(
      postgresCellDatabase({
        baseUrl: "postgresql://bench:secret@127.0.0.1:5423/appstrate?sslmode=disable",
        runId: "run-1234",
        cellId: "pi-S-warm-c10-o10-r2",
      }),
    ).toEqual({
      databaseName: "chat_perf_run_1234_pi_s_warm_c10_o10_r2",
      databaseUrl:
        "postgresql://bench:secret@127.0.0.1:5423/chat_perf_run_1234_pi_s_warm_c10_o10_r2?sslmode=disable",
      adminUrl: "postgresql://bench:secret@127.0.0.1:5423/postgres?sslmode=disable",
    });
  });

  it("filters CPU samples to the exact benchmark wave", () => {
    const summary = summarizeCpuProfileWindow(
      {
        startTime: 1_000_000,
        nodes: [
          { id: 1, callFrame: { functionName: "alpha", url: "a.ts", lineNumber: 1 } },
          { id: 2, callFrame: { functionName: "beta", url: "b.ts", lineNumber: 2 } },
        ],
        samples: [1, 2, 2, 1],
        timeDeltas: [1_000, 1_000, 1_000, 1_000],
      },
      { startEpochMs: 1_001, endEpochMs: 1_004 },
    );

    expect(summary.sampledMicros).toBe(3_000);
    expect(
      summary.functions.map(({ functionName, selfMicros }) => [functionName, selfMicros]),
    ).toEqual([
      ["beta", 2_000],
      ["alpha", 1_000],
    ]);
    expect(summary.functions[0]?.selfPercent).toBeCloseTo(66.67, 2);
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

  it("numbers independently scheduled benchmark repetitions without collisions", () => {
    expect(repetitionNumbers(2, 2)).toEqual([2, 3]);
    expect(() => repetitionNumbers(0, 1)).toThrow();
  });

  it("uses a platform MCP tool shape in replayed structured history", () => {
    expect(benchmarkHistoryToolPart("ORG0001_USER0001")).toMatchObject({
      toolName: "search_operations",
      toolCallId: "c00010001",
      state: "output-available",
      output: { content: [{ type: "text" }] },
    });
    expect(benchmarkHistoryToolPart("ORG0001_USER0001").toolCallId).toMatch(/^[A-Za-z0-9]{9}$/);
  });

  it("pins the low-cost model for each Pi subscription benchmark", () => {
    expect(defaultSubscriptionModel("codex")).toBe("gpt-5.6-luna");
    expect(defaultSubscriptionModel("claude-code")).toBe("claude-haiku-4-5");
    expect(() => defaultSubscriptionModel("anthropic")).toThrow();
  });

  it("gives raw observations a collision-free campaign name", () => {
    expect(publishedObservationName("artifacts/perf/codex", "pi-S-cold-c1-o1-r1.json")).toBe(
      "codex--pi-S-cold-c1-o1-r1.json",
    );
  });

  it("waits for usage only after a completed error-free model turn", () => {
    expect(completedTurnHasUsage({ status: 200, complete: true, error: null })).toBeTrue();
    expect(completedTurnHasUsage({ status: 200, complete: true, error: "provider" })).toBeFalse();
    expect(completedTurnHasUsage({ status: 429, complete: false, error: null })).toBeFalse();
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
