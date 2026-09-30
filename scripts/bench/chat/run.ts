#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Chat latency benchmark — see README.md next to this file.
 *
 *   bun run bench:chat --label base --net-latency 5
 *   bun run bench:chat --checkout ../wt-fix --label fix --net-latency 5
 *   bun run bench:chat:compare claudedocs/bench/chat/base.json claudedocs/bench/chat/fix.json
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  newSessionId,
  seedUser,
  sendTurn,
  userMessage,
  type BenchUser,
  type TurnTimings,
  type UiMessage,
} from "./client.ts";
import { startLatencyProxy } from "./latency-proxy.ts";
import { DEFAULT_MOCK_PROFILE, startMockLlm, type MockLlm, type MockProfile } from "./mock-llm.ts";
import {
  completed,
  metricsOf,
  metricValue,
  SCENARIOS,
  type BenchResult,
  type Scenario,
  type TurnRecord,
  type UiRecord,
  type UpstreamSide,
} from "./results.ts";
import {
  INFRAS,
  PROD_LIKE_ENV,
  readDotenv,
  startServer,
  type BenchServer,
  type Infra,
} from "./server.ts";
import { fmt, summarize, type Summary } from "./stats.ts";
import { openBrowser } from "./ui.ts";

const SCENARIO_DOC: Record<Scenario, string> = {
  cold: "fresh process per turn (first message after a deploy/restart), new conversation",
  "warm-new": "warmed process, each turn opens a new conversation",
  "follow-up": "warmed process, one conversation, turn after turn (history grows)",
  idle: "warmed process, new conversation after an idle gap (in-process caches, pooled sockets expired)",
  ui: "warmed process, new conversation typed into the SPA in Chromium; the page timestamps what is on screen",
};

const PROMPTS = [
  "What is the capital of Australia? Answer in one sentence.",
  "Give me three title ideas for an article about remote work.",
  "Explain in two sentences what a database index is.",
  "Translate into French: “The report is ready, I will send it to you tomorrow morning.”",
  "Summarize in one sentence why automated tests are worth having.",
];

/** `/api/chat` allows 20 turns a minute per user. */
const CHAT_RATE_LIMIT_INTERVAL_MS = 60_000 / 20;

// ─── arguments ──────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    checkout: { type: "string" },
    label: { type: "string", default: "run" },
    infra: { type: "string", default: "prod-like" },
    upstream: { type: "string", default: "mock" },
    "mock-profile": { type: "string" },
    scenarios: { type: "string", default: "cold,warm-new,follow-up" },
    runs: { type: "string", default: "8" },
    warmup: { type: "string", default: "2" },
    "min-interval": { type: "string", default: "3500" },
    "idle-gap": { type: "string", default: "45000" },
    port: { type: "string", default: "3999" },
    out: { type: "string" },
    env: { type: "string", multiple: true, default: [] },
    body: { type: "string" },
    "keep-infra": { type: "boolean", default: false },
    "net-latency": { type: "string", default: "0" },
  },
});

function intArg(name: keyof typeof args, min: number): number {
  const value = Number(args[name]);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`--${name} must be an integer ≥ ${min}`);
  }
  return value;
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`--${name} ${value}: expected one of ${allowed.join(", ")}`);
  }
  return value as T;
}

const repoRoot = resolve(import.meta.dir, "../../..");
const checkout = resolve(args.checkout ?? repoRoot);
const label = args.label;
const infra: Infra = oneOf("infra", args.infra, INFRAS);
const upstream = oneOf("upstream", args.upstream, ["mock", "real"] as const);
const scenarios = [...new Set(args.scenarios.split(","))].map((s) =>
  oneOf("scenarios", s, SCENARIOS),
);
const runs = intArg("runs", 1);
const warmup = intArg("warmup", 0);
const minInterval = intArg("min-interval", CHAT_RATE_LIMIT_INTERVAL_MS);
const idleGap = intArg("idle-gap", 0);
const port = intArg("port", 1);
const netLatency = intArg("net-latency", 0);
const extraEnv = Object.fromEntries(
  args.env.map((pair) => {
    const i = pair.indexOf("=");
    if (i <= 0) throw new Error(`--env ${pair}: expected KEY=value`);
    return [pair.slice(0, i), pair.slice(i + 1)];
  }),
);
const extraBody = args.body ? (JSON.parse(args.body) as Record<string, unknown>) : {};
const profile: MockProfile | null =
  upstream === "mock"
    ? {
        ...DEFAULT_MOCK_PROFILE,
        ...(JSON.parse(args["mock-profile"] ?? "{}") as Partial<MockProfile>),
      }
    : null;
if (netLatency > 0 && infra !== "prod-like") {
  throw new Error("--net-latency needs --infra prod-like");
}
if (scenarios.includes("ui")) {
  if (!profile) {
    throw new Error("the ui scenario detects the mock upstream's text: it needs --upstream mock");
  }
  if (!existsSync(join(checkout, "apps/web/dist/index.html"))) {
    throw new Error(
      `the ui scenario serves ${checkout}/apps/web/dist: build it first (cd apps/web && bunx vite build)`,
    );
  }
}

const outDir = resolve(args.out ?? join(repoRoot, "claudedocs", "bench", "chat"));
const workRoot = join(outDir, `.work-${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const dataDir = join(workRoot, "data");

// ─── teardown ───────────────────────────────────────────────────────────────

// Everything started (docker stack, relays, mock, platform, Chromium) is
// released by the `finally` that owns it, or on Ctrl-C by the signal handler:
// a long bench is often interrupted, and a leaked stack holds the bench ports.
const live = new Set<() => Promise<void>>();
let interrupted = false;

function track(release: () => unknown): () => Promise<void> {
  let done: Promise<void> | null = null;
  // Stays in `live` until released, so an interrupt waits for a release already under way.
  const dispose = () =>
    (done ??= (async () => {
      try {
        await release();
      } finally {
        live.delete(dispose);
      }
    })());
  live.add(dispose);
  return dispose;
}

/** While the teardown runs, the scenario loop must not start another turn or boot. */
function throwIfInterrupted() {
  if (interrupted) throw new Error("interrupted");
}

async function releaseAll() {
  for (const dispose of [...live].reverse()) {
    await dispose().catch((err: unknown) => console.error(`  ! teardown: ${String(err)}`));
  }
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.once(signal, () => {
    interrupted = true;
    void releaseAll().finally(() => {
      writeResult();
      process.exit(code);
    });
  });
}

// ─── infrastructure ─────────────────────────────────────────────────────────

const compose = ["docker", "compose", "-f", join(import.meta.dir, "docker-compose.bench.yml")];

async function sh(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")} failed: ${stderr}`);
}

/** Starts the data tier; returns the env overrides that route the platform through the delay relays. */
async function infraUp(): Promise<Record<string, string>> {
  if (infra !== "prod-like") return {};
  if (!args["keep-infra"]) {
    // A fresh stack per bench run: every variant starts from the same empty state.
    await sh([...compose, "down", "-v", "--remove-orphans"]);
    track(() => sh([...compose, "down", "-v"]));
  }
  // `--wait` would read the one-shot bucket creator's exit as a failure.
  await sh([...compose, "up", "-d", "--wait", "postgres", "redis", "minio"]);
  await sh([...compose, "run", "--rm", "minio-init"]);
  if (netLatency === 0) return {};
  const relayed = (url: string) => {
    const target = new URL(url);
    const proxy = startLatencyProxy(0, Number(target.port), netLatency);
    track(() => proxy.stop());
    target.port = String(proxy.port);
    return target.toString();
  };
  return {
    DATABASE_URL: relayed(PROD_LIKE_ENV.DATABASE_URL),
    REDIS_URL: relayed(PROD_LIKE_ENV.REDIS_URL),
  };
}

// ─── upstream ───────────────────────────────────────────────────────────────

async function systemProviderKeys(mock: MockLlm | null): Promise<unknown[]> {
  if (mock) {
    // Production's shape: one aliased system model behind `appstrate-model`.
    return [
      {
        id: "bench-mock",
        providerId: "openai-compatible",
        apiKey: "sk-bench-mock",
        baseUrlOverride: `${mock.url}/v1`,
        models: [
          {
            id: "appstrate-model",
            modelId: "bench-model",
            label: "Appstrate Model",
            aliased: true,
            isDefault: true,
          },
        ],
      },
    ];
  }
  const raw =
    process.env.BENCH_SYSTEM_PROVIDER_KEYS ??
    (await readDotenv(join(repoRoot, ".env"))).SYSTEM_PROVIDER_KEYS;
  if (!raw) {
    throw new Error(
      "--upstream real needs BENCH_SYSTEM_PROVIDER_KEYS, or SYSTEM_PROVIDER_KEYS in .env",
    );
  }
  return JSON.parse(raw) as unknown[];
}

/** The mock's view of the turn sent at `t.sentAt`: the calls it received before the turn ended. */
function upstreamSide(mock: MockLlm | null, t: TurnTimings): UpstreamSide | null {
  if (!mock) return null;
  const calls = mock.records.filter(
    (r) => r.receivedAt >= t.sentAt && r.receivedAt <= t.sentAt + (t.endMs ?? 0),
  );
  const first = calls[0];
  const upstreamVisibleAt = first ? (first.firstReasoningAt ?? first.firstContentAt) : null;
  return {
    upstreamCalls: calls.length,
    toUpstreamMs: first ? first.receivedAt - t.sentAt : null,
    relayMs:
      upstreamVisibleAt !== null && t.firstVisibleMs !== null
        ? t.sentAt + t.firstVisibleMs - upstreamVisibleAt
        : null,
    reasoningEffort: first?.reasoningEffort ?? null,
    maxTokens: first?.maxTokens ?? null,
    bodyBytes: first?.bodyBytes ?? null,
    toolCount: first?.toolCount ?? null,
    messageCount: first?.messageCount ?? null,
  };
}

// ─── one turn, joined with the server's own phase logs ──────────────────────

const SERVER_LOG_FIELDS: Record<string, string[]> = {
  "chat preamble": ["preambleMs", "phaseAMs", "phaseBMs", "claimTurnMs"],
  "chat turn response": ["toResponseMs"],
  "chat turn construction": [
    "mcpHandshakeMs",
    "sdkLoadMs",
    "loaderMs",
    "sessionMs",
    "constructionMs",
    "firstModelEventMs",
  ],
};

/**
 * The phase fields the platform logged for the turn sent at `sentAt`. Turns
 * never overlap, so the first line of each kind after `sentAt` is this turn's;
 * `chat turn construction` is logged when the turn settles, and carries the
 * session id, so it is waited for and matched on both. A completed turn must
 * carry every line and field: a renamed one fails the run instead of reading
 * as a column of nulls.
 */
async function serverPhases(
  server: BenchServer,
  sentAt: number,
  sessionId: string,
  completedTurn: boolean,
) {
  const ours = (msg: string) => server.logs.filter((l) => l.at >= sentAt && l.msg === msg);
  const construction = () =>
    ours("chat turn construction").find((l) => l.fields.chatSessionId === sessionId);
  const deadline = Date.now() + 5000;
  while (!construction() && Date.now() < deadline) await Bun.sleep(50);

  const out: Record<string, number | null> = {};
  for (const [msg, fields] of Object.entries(SERVER_LOG_FIELDS)) {
    const line = msg === "chat turn construction" ? construction() : ours(msg)[0];
    for (const field of fields) {
      if (completedTurn && !(line && Object.hasOwn(line.fields, field))) {
        throw new Error(
          `no "${msg}" log with ${field} for a completed turn: SERVER_LOG_FIELDS is stale`,
        );
      }
      out[field] = metricValue(line?.fields ?? {}, [field]);
    }
  }
  const proxied = ours("llm-proxy call");
  out.llmProxyCalls = proxied.length;
  out.llmProxyFirstMs = metricValue(proxied[0]?.fields ?? {}, ["durationMs"]);
  return out;
}

let lastSend = 0;
/** Stays under the chat rate limit, across scenarios and server restarts (the limiter lives in Redis). */
async function pace() {
  throwIfInterrupted();
  const wait = lastSend + minInterval - Date.now();
  if (wait > 0) await Bun.sleep(wait);
  lastSend = Date.now();
}

const prompt = (i: number) => PROMPTS[((i % PROMPTS.length) + PROMPTS.length) % PROMPTS.length]!;

interface Context {
  server: BenchServer;
  user: BenchUser;
  mock: MockLlm | null;
}

async function turn(
  ctx: Context,
  scenario: TurnRecord["scenario"],
  index: number,
  sessionId: string,
  history: UiMessage[],
): Promise<{ record: TurnRecord; assistant: UiMessage | null }> {
  await pace();
  const { timings, assistant } = await sendTurn(
    ctx.server.origin,
    ctx.user,
    sessionId,
    history,
    extraBody,
  );
  const record: TurnRecord = {
    ...timings,
    scenario,
    index,
    historyLength: history.length,
    server: await serverPhases(ctx.server, timings.sentAt, sessionId, !timings.error),
    upstream: upstreamSide(ctx.mock, timings),
  };
  const s = record.server;
  console.log(
    `  ${scenario}#${index} status=${record.status} firstVisible=${fmt(record.firstVisibleMs)} firstText=${fmt(record.firstTextMs)} end=${fmt(record.endMs)} preamble=${fmt(s.preambleMs)} mcp=${fmt(s.mcpHandshakeMs)} toUpstream=${fmt(record.upstream?.toUpstreamMs)}${record.error ? ` ! ${record.error.slice(0, 200)}` : ""}`,
  );
  return { record, assistant };
}

async function newConversationTurn(ctx: Context, scenario: TurnRecord["scenario"], i: number) {
  return (await turn(ctx, scenario, i, newSessionId(), [userMessage(prompt(i))])).record;
}

// ─── scenarios ──────────────────────────────────────────────────────────────

/** Measured turns, recorded as each one lands so an interrupted run keeps them. */
const records: (TurnRecord | UiRecord)[] = [];
const boots: number[] = [];

async function withServer<T>(
  bootLabel: string,
  keys: unknown[],
  env: Record<string, string>,
  body: (server: BenchServer) => Promise<T>,
): Promise<{ result: T; bootMs: number }> {
  throwIfInterrupted();
  let release = async () => {};
  try {
    const server = await startServer({
      checkout,
      port,
      infra,
      workDir: join(workRoot, bootLabel),
      dataDir,
      systemProviderKeys: keys,
      env,
      onSpawn: (stop) => (release = track(stop)),
    });
    return { result: await body(server), bootMs: server.bootMs };
  } finally {
    await release();
  }
}

async function warmScenario(ctx: Context, scenario: TurnRecord["scenario"]): Promise<void> {
  for (let i = 0; i < warmup; i++) await newConversationTurn(ctx, scenario, -1 - i);
  if (scenario === "follow-up") {
    const sessionId = newSessionId();
    const history: UiMessage[] = [];
    for (let i = 0; i < runs; i++) {
      history.push(userMessage(prompt(i)));
      const { record, assistant } = await turn(ctx, scenario, i, sessionId, history);
      records.push(record);
      if (assistant) history.push(assistant);
    }
    return;
  }
  for (let i = 0; i < runs; i++) {
    if (scenario === "idle") await Bun.sleep(idleGap);
    records.push(await newConversationTurn(ctx, scenario, i));
  }
}

async function uiScenario(ctx: Context, expectedWords: number): Promise<void> {
  const browser = await openBrowser(repoRoot);
  const close = track(() => browser.close());
  try {
    for (let i = -warmup; i < runs; i++) {
      await pace();
      const t = await browser.turn(ctx.server.origin, ctx.user, prompt(i), expectedWords);
      console.log(
        `  ui#${i} dots=${fmt(t.dotsMs)} firstText=${fmt(t.firstTextMs)} blank=${fmt(t.blankMs)} lastText=${fmt(t.lastTextMs)} longTaskMs=${fmt(t.longTaskMs)} slowFrames=${fmt(t.slowFrames)} maxFrame=${fmt(t.maxFrameMs)}${t.error ? ` ! ${t.error.slice(0, 200)}` : ""}`,
      );
      if (i >= 0) records.push({ ...t, scenario: "ui", index: i });
    }
  } finally {
    await close();
  }
}

let complete = false;
let written: { result: BenchResult; file: string } | null = null;

/** Writes what was measured, once: also when a boot fails or the run is interrupted. */
function writeResult(): { result: BenchResult; file: string } {
  if (written) return written;
  const summary: Record<string, Record<string, Summary | null>> = {};
  for (const scenario of scenarios) {
    const rows = completed(records, scenario);
    summary[scenario] = Object.fromEntries(
      Object.entries(metricsOf(scenario)).map(([name, path]) => [
        name,
        summarize(rows.map((r) => metricValue(r, path))),
      ]),
    );
  }
  const gitHead = Bun.spawnSync(["git", "-C", checkout, "rev-parse", "--short", "HEAD"])
    .stdout.toString()
    .trim();
  const result: BenchResult = {
    label,
    at: new Date().toISOString(),
    checkout,
    gitHead,
    complete,
    infra,
    netLatencyMs: netLatency,
    upstream,
    mockProfile: profile,
    extraEnvKeys: Object.keys(extraEnv),
    extraBody,
    runs,
    warmup,
    boots: summarize(boots),
    summary,
    records,
  };
  const file = join(outDir, `${label}.json`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(file, JSON.stringify(result, null, 2));
  return (written = { result, file });
}

async function main() {
  try {
    const relayEnv = await infraUp();
    const mock = profile ? startMockLlm(profile) : null;
    if (mock) track(() => mock.stop());
    const keys = await systemProviderKeys(mock);
    // The mock listens on loopback, which the platform's egress guard refuses by default.
    const env = {
      ...relayEnv,
      ...(mock ? { EGRESS_ALLOW_INTERNAL_HOSTS: "127.0.0.1" } : {}),
      ...extraEnv,
    };

    // A setup boot applies the migrations and seeds the user, so no measured
    // boot or turn pays for either.
    const { result: user } = await withServer("setup", keys, env, (server) =>
      seedUser(server.origin),
    );

    for (const scenario of scenarios) {
      console.log(`\n▶ ${scenario} — ${SCENARIO_DOC[scenario]}`);
      if (scenario === "cold") {
        for (let i = 0; i < runs; i++) {
          const { bootMs } = await withServer(`cold-${i}`, keys, env, async (server) => {
            records.push(await newConversationTurn({ server, user, mock }, scenario, i));
          });
          boots.push(bootMs);
        }
        continue;
      }
      const { bootMs } = await withServer(scenario, keys, env, (server) =>
        scenario === "ui"
          ? uiScenario({ server, user, mock }, profile!.textTokens)
          : warmScenario({ server, user, mock }, scenario),
      );
      boots.push(bootMs);
    }
    complete = true;
  } finally {
    await releaseAll();
    rmSync(dataDir, { recursive: true, force: true });
    const { file } = writeResult();
    if (!complete) console.error(`\nstopped early; what was measured is in ${file}`);
  }

  const { result, file } = writeResult();
  console.log(
    `\n${label} @ ${result.gitHead} (${infra}, net+${netLatency}ms, upstream=${upstream}) — medians ms (p90)`,
  );
  for (const [scenario, row] of Object.entries(result.summary)) {
    const cells = Object.entries(row).map(
      ([name, s]) => `${name}=${fmt(s?.median)}(${fmt(s?.p90)})`,
    );
    console.log(`  ${scenario.padEnd(10)} ${cells.join(" ")}`);
  }
  console.log(`\nwritten ${file}; server logs in ${workRoot}`);
}

await main();
