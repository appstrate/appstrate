// SPDX-License-Identifier: Apache-2.0

export const CHAT_PERFORMANCE_OBSERVATION_VERSION = 1 as const;

export interface MemorySample {
  elapsedMs: number;
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  cpuUserMicros: number;
  cpuSystemMicros: number;
  eventLoopDelayMs: number;
}

export interface MemoryCheckpointSet {
  initial: MemorySample;
  peak: MemorySample;
  end: MemorySample;
  after30s: MemorySample | null;
  after60s: MemorySample | null;
  after120s: MemorySample | null;
}

export interface ComparisonCounters {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface BenchmarkWorker {
  exited: Promise<number>;
  kill(signal: number): void;
}

export interface PiLifecycleSample {
  turnId: string;
  stage: string;
  durationMs: number;
}

export interface PiPromptMilestoneSample {
  turnId: string;
  milestone: string;
  elapsedMs: number;
}

export interface ChatTurnMilestoneSample {
  turnId: string;
  milestone: string;
  elapsedMs: number;
}

export interface PiTurnTimelineInput {
  turnId: string;
  requestStartedAt: number;
  engineEnteredAt: number;
  promptStartedAt: number;
  firstTextAt: number;
  clientFirstTokenAt: number;
  lifecycleTotalMs: number;
}

export interface PiTurnTimeline {
  turnId: string;
  routeToEngineMs: number;
  engineToPromptMs: number;
  measuredLifecycleMs: number;
  unmeasuredEngineSetupMs: number;
  promptToFirstTextMs: number;
  firstTextToClientMs: number;
  requestToClientFirstTokenMs: number;
}

export function postgresCellDatabase(input: { baseUrl: string; runId: string; cellId: string }): {
  databaseName: string;
  databaseUrl: string;
  adminUrl: string;
} {
  const base = new URL(input.baseUrl);
  if (base.protocol !== "postgres:" && base.protocol !== "postgresql:") {
    throw new Error("PostgreSQL benchmark URL must use postgres:// or postgresql://");
  }
  const suffix = `${input.runId}_${input.cellId}`
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
  const databaseName = `chat_perf_${suffix}`.slice(0, 63);
  if (!/^chat_perf_[a-z0-9_]+$/.test(databaseName)) {
    throw new Error("Could not derive a safe PostgreSQL benchmark database name");
  }
  const database = new URL(base);
  database.pathname = `/${databaseName}`;
  const admin = new URL(base);
  admin.pathname = "/postgres";
  return {
    databaseName,
    databaseUrl: database.toString(),
    adminUrl: admin.toString(),
  };
}

export function benchmarkWorkerCommand(input: {
  executable: string;
  script: string;
  cpuProfile?: { directory: string; name: string };
}): string[] {
  return [
    input.executable,
    ...(input.cpuProfile
      ? [
          "--cpu-prof",
          `--cpu-prof-dir=${input.cpuProfile.directory}`,
          `--cpu-prof-name=${input.cpuProfile.name}`,
        ]
      : []),
    input.script,
    "--worker",
  ];
}

export interface CpuProfileInput {
  startTime: number;
  nodes: ReadonlyArray<{
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
  }>;
  samples: readonly number[];
  timeDeltas: readonly number[];
}

/** Read one explicitly requested variable from dotenv text without importing the rest. */
export function parseDotEnvValue(contents: string, name: string): string | null {
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] !== name) continue;
    const raw = match[2] ?? "";
    if (
      raw.length >= 2 &&
      ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
    ) {
      return raw.slice(1, -1);
    }
    return raw;
  }
  return null;
}

export function repetitionNumbers(start: number, count: number): number[] {
  if (!Number.isInteger(start) || start < 1) throw new Error("repetition start must be positive");
  if (!Number.isInteger(count) || count < 1) throw new Error("repetition count must be positive");
  return Array.from({ length: count }, (_, index) => start + index);
}

export function benchmarkHistoryToolPart(marker: string) {
  const toolCallId = `c${marker.replaceAll(/\D/g, "").slice(-8).padStart(8, "0")}`;
  return {
    type: "dynamic-tool",
    toolName: "search_operations",
    toolCallId,
    state: "output-available",
    input: { query: marker },
    output: {
      content: [{ type: "text", text: JSON.stringify({ marker, ok: true }) }],
    },
  } as const;
}

export function defaultSubscriptionModel(providerId: string): string {
  if (providerId === "codex") return "gpt-5.6-luna";
  if (providerId === "claude-code") return "claude-haiku-4-5";
  throw new Error(`Unsupported subscription provider: ${providerId}`);
}

export function publishedObservationName(inputDirectory: string, filename: string): string {
  const campaign = inputDirectory.replaceAll(/\/+$/g, "").split("/").at(-1);
  if (!campaign || !filename.endsWith(".json")) throw new Error("Invalid observation source");
  return `${campaign}--${filename}`;
}

export function completedTurnHasUsage(turn: {
  status: number;
  complete: boolean;
  error: string | null;
}): boolean {
  return turn.status === 200 && turn.complete && turn.error === null;
}

/** Wait for a worker and guarantee that a timed-out process cannot survive its controller. */
export async function waitForWorkerExit(
  worker: BenchmarkWorker,
  timeoutMs: number,
  gracefulShutdownMs = 1_000,
): Promise<number> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const first = await Promise.race([
    worker.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
    timedOut.then(() => ({ kind: "timeout" as const })),
  ]);
  if (timeout) clearTimeout(timeout);
  if (first.kind === "exit") return first.exitCode;

  worker.kill(15);
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const graceExpired = new Promise<"expired">((resolve) => {
    graceTimer = setTimeout(() => resolve("expired"), gracefulShutdownMs);
  });
  const graceful = await Promise.race([
    worker.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
    graceExpired.then(() => ({ kind: "expired" as const })),
  ]);
  if (graceTimer) clearTimeout(graceTimer);
  if (graceful.kind === "expired") {
    worker.kill(9);
    await worker.exited;
  }
  throw new Error(`benchmark worker exceeded ${timeoutMs} ms`);
}

/** Normalize both fetch call shapes before the controlled dispatch inspects the request. */
export function normalizeFetchRequest(input: string | URL | Request, init?: RequestInit): Request {
  return input instanceof Request && init === undefined ? input : new Request(input, init);
}

export function percentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null;
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
    throw new RangeError("quantile must be between 0 and 1");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(quantile * sorted.length));
  return sorted[rank - 1]!;
}

export function summarizeDurations(values: readonly number[]): {
  p50: number | null;
  p95: number | null;
  p99: number | null;
} {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
  };
}

export function summarizePiLifecycle(samples: readonly PiLifecycleSample[]): {
  sampleCount: number;
  stagesMs: Record<string, ReturnType<typeof summarizeDurations>>;
  prePromptTotalMs: ReturnType<typeof summarizeDurations>;
} {
  const stages = new Map<string, number[]>();
  const totals = new Map<string, number>();
  for (const sample of samples) {
    const durations = stages.get(sample.stage) ?? [];
    durations.push(sample.durationMs);
    stages.set(sample.stage, durations);
    totals.set(sample.turnId, (totals.get(sample.turnId) ?? 0) + sample.durationMs);
  }
  return {
    sampleCount: totals.size,
    stagesMs: Object.fromEntries(
      [...stages.entries()].map(([stage, durations]) => [stage, summarizeDurations(durations)]),
    ),
    prePromptTotalMs: summarizeDurations([...totals.values()]),
  };
}

export function summarizePiPromptMilestones(samples: readonly PiPromptMilestoneSample[]): {
  sampleCount: number;
  milestonesMs: Record<string, ReturnType<typeof summarizeDurations>>;
} {
  const milestones = new Map<string, number[]>();
  const turns = new Set<string>();
  for (const sample of samples) {
    turns.add(sample.turnId);
    const elapsed = milestones.get(sample.milestone) ?? [];
    elapsed.push(sample.elapsedMs);
    milestones.set(sample.milestone, elapsed);
  }
  return {
    sampleCount: turns.size,
    milestonesMs: Object.fromEntries(
      [...milestones.entries()].map(([milestone, elapsed]) => [
        milestone,
        summarizeDurations(elapsed),
      ]),
    ),
  };
}

export function summarizeChatTurnMilestones(samples: readonly ChatTurnMilestoneSample[]): {
  sampleCount: number;
  milestonesMs: Record<string, ReturnType<typeof summarizeDurations>>;
} {
  return summarizePiPromptMilestones(samples);
}

export function buildPiTurnTimeline(input: PiTurnTimelineInput): PiTurnTimeline {
  const engineToPromptMs = input.promptStartedAt - input.engineEnteredAt;
  return {
    turnId: input.turnId,
    routeToEngineMs: input.engineEnteredAt - input.requestStartedAt,
    engineToPromptMs,
    measuredLifecycleMs: input.lifecycleTotalMs,
    unmeasuredEngineSetupMs: engineToPromptMs - input.lifecycleTotalMs,
    promptToFirstTextMs: input.firstTextAt - input.promptStartedAt,
    firstTextToClientMs: input.clientFirstTokenAt - input.firstTextAt,
    requestToClientFirstTokenMs: input.clientFirstTokenAt - input.requestStartedAt,
  };
}

export function summarizeCpuProfileWindow(
  profile: CpuProfileInput,
  window: { startEpochMs: number; endEpochMs: number },
): {
  sampledMicros: number;
  functions: Array<{
    functionName: string;
    url: string;
    lineNumber: number;
    selfMicros: number;
    selfPercent: number;
  }>;
} {
  const startMicros = window.startEpochMs * 1_000;
  const endMicros = window.endEpochMs * 1_000;
  const nodes = new Map(profile.nodes.map((node) => [node.id, node.callFrame]));
  const functions = new Map<
    string,
    { functionName: string; url: string; lineNumber: number; selfMicros: number }
  >();
  let sampledMicros = 0;
  let sampleStartedAt = profile.startTime;

  for (let index = 0; index < profile.samples.length; index += 1) {
    const sampleEndedAt = sampleStartedAt + (profile.timeDeltas[index] ?? 0);
    const overlapMicros = Math.max(
      0,
      Math.min(sampleEndedAt, endMicros) - Math.max(sampleStartedAt, startMicros),
    );
    if (overlapMicros > 0) {
      const frame = nodes.get(profile.samples[index]!);
      if (frame) {
        const key = `${frame.functionName}\u0000${frame.url}\u0000${frame.lineNumber}`;
        const aggregate = functions.get(key) ?? { ...frame, selfMicros: 0 };
        aggregate.selfMicros += overlapMicros;
        functions.set(key, aggregate);
        sampledMicros += overlapMicros;
      }
    }
    sampleStartedAt = sampleEndedAt;
  }

  return {
    sampledMicros,
    functions: [...functions.values()]
      .sort((left, right) => right.selfMicros - left.selfMicros)
      .map((entry) => ({
        ...entry,
        selfPercent: sampledMicros === 0 ? 0 : (entry.selfMicros / sampledMicros) * 100,
      })),
  };
}

function firstAtOrAfter(samples: readonly MemorySample[], elapsedMs: number): MemorySample | null {
  return samples.find((sample) => sample.elapsedMs >= elapsedMs) ?? null;
}

export function memoryCheckpoints(
  samples: readonly MemorySample[],
  timing: { waveStartedAtMs: number; waveEndedAtMs: number },
): MemoryCheckpointSet {
  if (samples.length === 0) throw new Error("at least one memory sample is required");
  const initial = firstAtOrAfter(samples, timing.waveStartedAtMs) ?? samples[0]!;
  const waveSamples = samples.filter(
    (sample) =>
      sample.elapsedMs >= timing.waveStartedAtMs && sample.elapsedMs <= timing.waveEndedAtMs,
  );
  const peak = (waveSamples.length > 0 ? waveSamples : [initial]).reduce((highest, sample) =>
    sample.rss > highest.rss ? sample : highest,
  );
  const end = firstAtOrAfter(samples, timing.waveEndedAtMs) ?? samples.at(-1)!;
  return {
    initial,
    peak,
    end,
    after30s: firstAtOrAfter(samples, timing.waveEndedAtMs + 30_000),
    after60s: firstAtOrAfter(samples, timing.waveEndedAtMs + 60_000),
    after120s: firstAtOrAfter(samples, timing.waveEndedAtMs + 120_000),
  };
}

export function summarizeWaveActivity(
  samples: readonly MemorySample[],
  timing: { waveStartedAtMs: number; waveEndedAtMs: number },
): {
  eventLoopDelayMs: ReturnType<typeof summarizeDurations>;
  cpu: { userMicros: number; systemMicros: number };
} {
  if (samples.length === 0) throw new Error("at least one memory sample is required");
  const initial = firstAtOrAfter(samples, timing.waveStartedAtMs) ?? samples[0]!;
  const end = firstAtOrAfter(samples, timing.waveEndedAtMs) ?? samples.at(-1)!;
  const waveSamples = samples.filter(
    (sample) =>
      sample.elapsedMs >= timing.waveStartedAtMs && sample.elapsedMs <= timing.waveEndedAtMs,
  );
  return {
    eventLoopDelayMs: summarizeDurations(
      (waveSamples.length > 0 ? waveSamples : [initial]).map((sample) => sample.eventLoopDelayMs),
    ),
    cpu: {
      userMicros: Math.max(0, end.cpuUserMicros - initial.cpuUserMicros),
      systemMicros: Math.max(0, end.cpuSystemMicros - initial.cpuSystemMicros),
    },
  };
}

export function compareCellInvariants(
  aiSdk: ComparisonCounters,
  pi: ComparisonCounters,
  explanation?: string,
): { valid: boolean; reasons: string[] } {
  const mismatches: string[] = [];
  if (aiSdk.modelCalls !== pi.modelCalls) {
    mismatches.push(`model_calls:${aiSdk.modelCalls}!=${pi.modelCalls}`);
  }
  if (aiSdk.inputTokens !== pi.inputTokens) {
    mismatches.push(`input_tokens:${aiSdk.inputTokens}!=${pi.inputTokens}`);
  }
  if (aiSdk.outputTokens !== pi.outputTokens) {
    mismatches.push(`output_tokens:${aiSdk.outputTokens}!=${pi.outputTokens}`);
  }
  if (mismatches.length === 0) return { valid: true, reasons: [] };
  if (explanation) return { valid: true, reasons: [explanation] };
  return { valid: false, reasons: mismatches };
}
