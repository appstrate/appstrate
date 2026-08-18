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

export async function forwardMistralChatCompletion(
  request: Request,
  options: {
    apiKey: string;
    modelId: string;
    fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    baseUrl?: string;
  },
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${options.apiKey}`);
  headers.set("content-type", "application/json");
  headers.delete("host");
  headers.delete("content-length");
  const upstreamBody = {
    ...body,
    model: options.modelId,
    ...(body.stream === true ? { stream_options: { include_usage: true } } : {}),
  };
  return options.fetch(options.baseUrl ?? "https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamBody),
    signal: request.signal,
  });
}

export function parseOpenAiSseUsage(
  contents: string,
): { inputTokens: number; outputTokens: number } | null {
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  for (const line of contents.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as {
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      };
      if (
        typeof parsed.usage?.prompt_tokens === "number" &&
        typeof parsed.usage.completion_tokens === "number"
      ) {
        usage = {
          inputTokens: parsed.usage.prompt_tokens,
          outputTokens: parsed.usage.completion_tokens,
        };
      }
    } catch {
      continue;
    }
  }
  return usage;
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
