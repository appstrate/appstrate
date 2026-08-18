// SPDX-License-Identifier: Apache-2.0

import { summarizeWaveActivity, type MemorySample } from "./chat-engine-performance-lib.ts";

export interface ConfidenceInterval {
  estimate: number;
  low: number;
  high: number;
  confidence: 0.95;
  method: "deterministic-nonparametric-bootstrap";
}

export interface ObservationValue {
  schemaVersion: number;
  benchmark: string;
  provider?: { id: string; modelId: string };
  timing?: { waveStartedAtMs: number; waveEndedAtMs: number };
  samples?: MemorySample[];
  cell: {
    engine: "ai-sdk" | "pi";
    form: string;
    profile: string;
    concurrency: number;
    repetition: number;
    distribution?: string;
  };
  memory: {
    initial: MemoryValue;
    peak: MemoryValue;
    end: MemoryValue;
    after30s?: MemoryValue | null;
    after60s?: MemoryValue | null;
    after120s?: MemoryValue | null;
  };
  eventLoopDelayMs: { p95: number | null };
  cpu?: { userMicros: number; systemMicros: number };
  latency: {
    firstTokenMs: { p95: number | null };
    totalMs: { p95: number | null };
    throughputChatsPerSecond: number;
  };
  outcomes: {
    requested: number;
    completed: number;
    rateLimited: number;
    serverErrors: number;
    incompleteStreams: number;
    markerFailures: number;
  };
  usage: {
    modelCalls: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
  };
  persistence: {
    messageCount: number;
    structuredPartCount: number;
    usageRows: number;
  };
  continuity: { complete: boolean; markerValid: boolean };
  isolation: { foreignSessionRejected: boolean };
}

interface MemoryValue {
  rss: number;
  heapUsed?: number;
  external?: number;
  arrayBuffers?: number;
}

export interface ReportObservation {
  source: string;
  value: ObservationValue;
}

export function bootstrapMedianInterval(
  values: readonly number[],
  iterations = 10_000,
  seed = 0x5eed1234,
): ConfidenceInterval {
  if (values.length === 0) throw new Error("bootstrap requires at least one value");
  let state = seed >>> 0;
  const random = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const resample = Array.from(
      { length: values.length },
      () => values[Math.floor(random() * values.length)]!,
    );
    samples.push(median(resample));
  }
  samples.sort((a, b) => a - b);
  return {
    estimate: median(values),
    low: samples[Math.floor(samples.length * 0.025)]!,
    high: samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.975) - 1)]!,
    confidence: 0.95,
    method: "deterministic-nonparametric-bootstrap",
  };
}

export function aggregatePerformanceObservations(observations: readonly ReportObservation[]) {
  const grouped = Map.groupBy(observations, ({ value }) =>
    [
      value.benchmark,
      providerKey(value),
      value.cell.engine,
      value.cell.form,
      value.cell.profile,
      value.cell.concurrency,
      value.cell.distribution ?? "unspecified",
    ].join("|"),
  );
  const groups = [...grouped.values()]
    .map((items) => {
      const first = items[0]!.value;
      const interval = (select: (value: ObservationValue) => number | null | undefined) => {
        const values = items
          .map(({ value }) => select(value))
          .filter((value): value is number => value != null);
        return values.length > 0 ? bootstrapMedianInterval(values) : null;
      };
      return {
        benchmark: first.benchmark,
        provider: first.provider?.id ?? "unspecified",
        modelId: first.provider?.modelId ?? "unspecified",
        engine: first.cell.engine,
        form: first.cell.form,
        profile: first.cell.profile,
        concurrency: first.cell.concurrency,
        distribution: first.cell.distribution ?? "unspecified",
        repetitions: items.length,
        observations: items.map(({ source }) => source).sort(),
        metrics: {
          firstTokenP95Ms: interval((value) => value.latency.firstTokenMs.p95),
          totalP95Ms: interval((value) => value.latency.totalMs.p95),
          throughputChatsPerSecond: interval((value) => value.latency.throughputChatsPerSecond),
          initialRssBytes: interval((value) => value.memory.initial.rss),
          peakRssBytes: interval((value) => value.memory.peak.rss),
          endRssBytes: interval((value) => value.memory.end.rss),
          eventLoopDelayP95Ms: interval((value) => measuredActivity(value).eventLoopDelayMs.p95),
          cpuUserMicros: interval((value) => measuredActivity(value).cpu.userMicros),
          cpuSystemMicros: interval((value) => measuredActivity(value).cpu.systemMicros),
          memory: {
            initial: memoryIntervals(items, (value) => value.memory.initial),
            peak: memoryIntervals(items, (value) => value.memory.peak),
            end: memoryIntervals(items, (value) => value.memory.end),
            after30s: memoryIntervals(items, (value) => value.memory.after30s),
            after60s: memoryIntervals(items, (value) => value.memory.after60s),
            after120s: memoryIntervals(items, (value) => value.memory.after120s),
          },
        },
        totals: sumCounters(items.map(({ value }) => value)),
        invariants: {
          continuityValid: items.every(
            ({ value }) => value.continuity.complete && value.continuity.markerValid,
          ),
          isolationValid: items.every(({ value }) => value.isolation.foreignSessionRejected),
        },
      };
    })
    .sort(compareGroups);

  const slopeFamilies = Map.groupBy(observations, ({ value }) =>
    [
      value.benchmark,
      providerKey(value),
      value.cell.engine,
      value.cell.form,
      value.cell.profile,
      distributionFamily(value),
    ].join("|"),
  );
  const memorySlopes = [...slopeFamilies.values()]
    .flatMap((items) => memorySlope(items) ?? [])
    .sort(compareGroups);

  return { schemaVersion: 1, kind: "chat-engine-performance-summary", groups, memorySlopes };
}

function measuredActivity(value: ObservationValue) {
  if (value.samples && value.timing) return summarizeWaveActivity(value.samples, value.timing);
  return {
    eventLoopDelayMs: value.eventLoopDelayMs,
    cpu: value.cpu ?? { userMicros: 0, systemMicros: 0 },
  };
}

function memoryIntervals(
  items: readonly ReportObservation[],
  select: (value: ObservationValue) => MemoryValue | null | undefined,
) {
  const samples = items.flatMap(({ value }) => select(value) ?? []);
  if (samples.length === 0) return null;
  const interval = (field: keyof MemoryValue) => {
    const values = samples
      .map((sample) => sample[field])
      .filter((value): value is number => value !== undefined);
    return values.length > 0 ? bootstrapMedianInterval(values) : null;
  };
  return {
    rssBytes: interval("rss")!,
    heapUsedBytes: interval("heapUsed"),
    externalBytes: interval("external"),
    arrayBuffersBytes: interval("arrayBuffers"),
  };
}

function memorySlope(items: readonly ReportObservation[]) {
  const concurrencies = [...new Set(items.map(({ value }) => value.cell.concurrency))].sort(
    (a, b) => a - b,
  );
  if (concurrencies.length < 2) return null;
  const fromConcurrency = concurrencies[0]!;
  const toConcurrency = concurrencies.at(-1)!;
  const first = items[0]!.value;
  const lowByRepetition = new Map(
    items
      .filter(({ value }) => value.cell.concurrency === fromConcurrency)
      .map(({ value }) => [value.cell.repetition, value.memory.peak.rss]),
  );
  const slopes = items
    .filter(({ value }) => value.cell.concurrency === toConcurrency)
    .flatMap(({ value }) => {
      const low = lowByRepetition.get(value.cell.repetition);
      return low === undefined
        ? []
        : [(value.memory.peak.rss - low) / (toConcurrency - fromConcurrency)];
    });
  if (slopes.length === 0) return null;
  return {
    benchmark: first.benchmark,
    provider: first.provider?.id ?? "unspecified",
    modelId: first.provider?.modelId ?? "unspecified",
    engine: first.cell.engine,
    form: first.cell.form,
    profile: first.cell.profile,
    distribution: distributionFamily(first),
    fromConcurrency,
    toConcurrency,
    pairedRepetitions: slopes.length,
    rssBytesPerChat: bootstrapMedianInterval(slopes),
  };
}

function sumCounters(values: readonly ObservationValue[]) {
  return values.reduce(
    (total, value) => ({
      requested: total.requested + value.outcomes.requested,
      completed: total.completed + value.outcomes.completed,
      rateLimited: total.rateLimited + value.outcomes.rateLimited,
      serverErrors: total.serverErrors + value.outcomes.serverErrors,
      incompleteStreams: total.incompleteStreams + value.outcomes.incompleteStreams,
      markerFailures: total.markerFailures + value.outcomes.markerFailures,
      modelCalls: total.modelCalls + value.usage.modelCalls,
      toolCalls: total.toolCalls + value.usage.toolCalls,
      inputTokens: total.inputTokens + value.usage.inputTokens,
      outputTokens: total.outputTokens + value.usage.outputTokens,
      messages: total.messages + value.persistence.messageCount,
      structuredParts: total.structuredParts + value.persistence.structuredPartCount,
      usageRows: total.usageRows + value.persistence.usageRows,
    }),
    {
      requested: 0,
      completed: 0,
      rateLimited: 0,
      serverErrors: 0,
      incompleteStreams: 0,
      markerFailures: 0,
      modelCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      messages: 0,
      structuredParts: 0,
      usageRows: 0,
    },
  );
}

function distributionFamily(value: ObservationValue): string {
  const distribution = value.cell.distribution ?? "unspecified";
  const match = distribution.match(/^(\d+)-organizations-x-(\d+)-chats?$/);
  if (!match) return distribution;
  if (Number(match[2]) === 1) return "one-organization-per-chat";
  if (Number(match[1]) === 1) return "single-organization";
  return `${match[1]}-organizations`;
}

function providerKey(value: ObservationValue): string {
  return `${value.provider?.id ?? "unspecified"}|${value.provider?.modelId ?? "unspecified"}`;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function compareGroups(
  left: {
    form: string;
    profile: string;
    engine: string;
    concurrency?: number;
    distribution?: string;
  },
  right: {
    form: string;
    profile: string;
    engine: string;
    concurrency?: number;
    distribution?: string;
  },
): number {
  return (
    left.form.localeCompare(right.form) ||
    left.profile.localeCompare(right.profile) ||
    (left.concurrency ?? 0) - (right.concurrency ?? 0) ||
    (left.distribution ?? "").localeCompare(right.distribution ?? "") ||
    left.engine.localeCompare(right.engine)
  );
}
