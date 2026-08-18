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
