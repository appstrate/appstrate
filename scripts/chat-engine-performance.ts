// SPDX-License-Identifier: Apache-2.0

/**
 * Reproducible local benchmark for the server chat engines.
 *
 * The controlled mode runs each cell in a fresh Bun process against the same
 * in-process llm-proxy-shaped deterministic upstream and an isolated PGlite
 * database. Nothing in this file is imported by, or reachable from, a
 * production build.
 */

import { $ } from "bun";
import {
  CHAT_PERFORMANCE_OBSERVATION_VERSION,
  memoryCheckpoints,
  normalizeFetchRequest,
  percentile,
  summarizeDurations,
  type MemorySample,
} from "./chat-engine-performance-lib.ts";
import type { ChatEnv } from "../packages/module-chat/src/prompt.ts";

type Engine = "ai-sdk" | "pi";
type ConversationForm = "S" | "H";
type Profile = "cold" | "warm";

interface WorkerConfig {
  engine: Engine;
  form: ConversationForm;
  profile: Profile;
  concurrency: number;
  repetition: number;
  recoveryMs: number;
  outputFile: string;
  databaseDir: string;
}

interface TurnObservation {
  marker: string;
  sessionId: string;
  status: number;
  firstTokenMs: number | null;
  totalMs: number;
  complete: boolean;
  markerValid: boolean;
  error: string | null;
}

interface SyntheticIdentity {
  marker: string;
  user: { id: string; email: string; name: string };
  orgId: string;
  orgName: string;
  orgSlug: string;
  appId: string;
  sessionId: string;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const argv = Bun.argv.slice(2);
const worker = argv.includes("--worker");

if (worker) {
  await runWorker(workerConfigFromEnvironment());
} else {
  await runController(argv);
}

async function runController(args: string[]): Promise<void> {
  const command = args[0] ?? "controlled";
  if (command !== "controlled") {
    throw new Error(`Unsupported benchmark command: ${command}`);
  }
  const engines = csvOption(args, "engines", ["ai-sdk", "pi"]) as Engine[];
  const forms = csvOption(args, "forms", ["S", "H"]) as ConversationForm[];
  const profiles = csvOption(args, "profiles", ["cold", "warm"]) as Profile[];
  const concurrencies = csvOption(args, "concurrency", ["1", "10", "30", "60", "64", "100"])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0);
  const repetitions = numberOption(args, "repetitions", 5);
  const recoveryMs = numberOption(args, "recovery-ms", 120_000);
  const outputDir = stringOption(args, "output", "artifacts/chat-engine-performance/controlled");

  await $`mkdir -p ${outputDir}`.quiet();
  const commit = textCommand(["git", "rev-parse", "HEAD"]);
  const startedAt = new Date().toISOString();
  const files: string[] = [];
  for (const form of forms) {
    for (const concurrency of concurrencies) {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        for (const profile of profiles) {
          for (const engine of engines) {
            const id = [engine, form, profile, `c${concurrency}`, `r${repetition}`].join("-");
            const outputFile = `${outputDir}/${id}.json`;
            const databaseDir = `${outputDir}/databases/${id}`;
            await $`mkdir -p ${databaseDir}`.quiet();
            const child = Bun.spawn([process.execPath, import.meta.path, "--worker"], {
              cwd: process.cwd(),
              env: {
                ...process.env,
                CHAT_PERF_ENGINE: engine,
                CHAT_PERF_FORM: form,
                CHAT_PERF_PROFILE: profile,
                CHAT_PERF_CONCURRENCY: String(concurrency),
                CHAT_PERF_REPETITION: String(repetition),
                CHAT_PERF_RECOVERY_MS: String(recoveryMs),
                CHAT_PERF_OUTPUT_FILE: outputFile,
                CHAT_PERF_DATABASE_DIR: databaseDir,
              },
              stdout: "inherit",
              stderr: "inherit",
            });
            const exitCode = await child.exited;
            if (exitCode !== 0) throw new Error(`Benchmark worker failed for ${id}`);
            const observation = (await Bun.file(outputFile).json()) as {
              outcomes: {
                requested: number;
                completed: number;
                incompleteStreams: number;
                markerFailures: number;
              };
              isolation: { foreignSessionRejected: boolean };
              continuity: { complete: boolean; markerValid: boolean };
            };
            if (
              observation.outcomes.completed !== observation.outcomes.requested ||
              observation.outcomes.incompleteStreams !== 0 ||
              observation.outcomes.markerFailures !== 0 ||
              !observation.isolation.foreignSessionRejected ||
              !observation.continuity.complete ||
              !observation.continuity.markerValid
            ) {
              throw new Error(`Controlled benchmark invariants failed for ${id}`);
            }
            files.push(outputFile);
          }
        }
      }
    }
  }
  const manifest = {
    schemaVersion: CHAT_PERFORMANCE_OBSERVATION_VERSION,
    kind: "chat-engine-performance-manifest",
    benchmark: "controlled",
    startedAt,
    completedAt: new Date().toISOString(),
    commit,
    bunVersion: Bun.version,
    command: Bun.argv.join(" "),
    parameters: { engines, forms, profiles, concurrencies, repetitions, recoveryMs },
    observations: files,
  };
  await Bun.write(`${outputDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function runWorker(config: WorkerConfig): Promise<void> {
  configureIsolatedEnvironment(config);
  const processStartedAt = performance.now();
  const samples: MemorySample[] = [];
  const cpuStart = process.cpuUsage();
  let expectedSampleAt = performance.now() + 100;
  const takeSample = (): void => {
    const now = performance.now();
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage(cpuStart);
    samples.push({
      elapsedMs: now - processStartedAt,
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      eventLoopDelayMs: Math.max(0, now - expectedSampleAt),
    });
    expectedSampleAt = now + 100;
  };
  takeSample();
  const sampler = setInterval(takeSample, 100);

  const { applyCorePGliteMigrations } = await import("../apps/api/src/lib/pglite-migrate.ts");
  await applyCorePGliteMigrations("packages/db/drizzle");
  const [
    { Hono },
    { eq },
    dbModule,
    schema,
    chatModule,
    piEngineModule,
    persistenceModule,
    errorModule,
  ] = await Promise.all([
    import("../packages/module-chat/node_modules/hono"),
    import("../packages/db/node_modules/drizzle-orm"),
    import("@appstrate/db/client"),
    import("@appstrate/db/schema"),
    import("../packages/module-chat/src/chat-stream.ts"),
    import("../packages/module-chat/src/pi-chat/engine.ts"),
    import("../packages/module-chat/src/persistence.ts"),
    import("../apps/api/src/middleware/error-handler.ts"),
  ]);
  const { db, closeDb } = dbModule;
  const identities = await seedIdentities(db, schema, config.concurrency);
  const sessionByMarker = new Map(
    identities.map((identity) => [identity.marker, identity.sessionId] as const),
  );
  const identityByOrg = new Map<string, SyntheticIdentity>(
    identities.map((identity) => [identity.orgId, identity] as const),
  );
  const identityByMarker = new Map<string, SyntheticIdentity>(
    identities.map((identity) => [identity.marker, identity] as const),
  );
  let phase: "warmup" | "wave" | "continuity" = "wave";
  const counters = {
    waveModelCalls: 0,
    waveToolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    statuses: { ok: 0, rateLimited: 0, serverError: 0 },
  };

  const controlledDispatch = createControlledDispatch({
    db,
    schema,
    sessionByMarker,
    identityByOrg,
    identityByMarker,
    onInference: (usage) => {
      if (phase !== "wave") return;
      counters.waveModelCalls += 1;
      counters.inputTokens += usage.inputTokens;
      counters.outputTokens += usage.outputTokens;
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = controlledDispatch as typeof fetch;

  const deps = {
    dispatch: controlledDispatch,
    rateLimit: () => async (_context: unknown, next: () => Promise<void>) => next(),
    resolveSubscriptionChatModel: async () => ({ subscription: false as const }),
    recordChatUsage: async () => {},
    resolveChatAttachment: async () => {
      throw new Error("controlled benchmark does not use attachments");
    },
    cleanupSessionDocuments: async () => {},
    checkUsageAllowed: async () => null,
  };
  const engineRuntime = {
    configuredPiOrgIds: () =>
      config.engine === "pi" ? identities.map((i) => i.orgId).join(",") : "",
    runPiChat: piEngineModule.runPiChat,
  };

  const app = new Hono<ChatEnv>();
  app.onError((error, context) => errorModule.errorHandler(error, context as never));
  app.post("/api/chat/:orgId", (context) => {
    const identity = identityByOrg.get(context.req.param("orgId"));
    if (!identity) return new Response("unknown synthetic organization", { status: 404 });
    context.set("orgId", identity.orgId);
    context.set("user", identity.user);
    context.set("orgRole", "owner");
    context.set("orgName", identity.orgName);
    context.set("orgSlug", identity.orgSlug);
    context.set("permissions", new Set<string>());
    return chatModule.handleChatStream(context as never, deps as never, engineRuntime);
  });

  const runTurn = async (
    identity: (typeof identities)[number],
    messages = conversation(config.form, identity.marker),
  ): Promise<TurnObservation> => {
    const startedAt = performance.now();
    try {
      const response = await app.request(`/api/chat/${identity.orgId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-application-id": identity.appId,
          "x-org-id": identity.orgId,
        },
        body: JSON.stringify({ id: identity.sessionId, messages }),
      });
      if (response.status === 200) counters.statuses.ok += 1;
      else if (response.status === 429) counters.statuses.rateLimited += 1;
      else if (response.status >= 500) counters.statuses.serverError += 1;
      const streamed = await readUiStream(response, startedAt);
      return {
        marker: identity.marker,
        sessionId: identity.sessionId,
        status: response.status,
        firstTokenMs: streamed.firstTokenMs,
        totalMs: performance.now() - startedAt,
        complete: streamed.complete,
        markerValid:
          streamed.text.includes(identity.marker) &&
          !identities.some(
            (candidate) =>
              candidate.marker !== identity.marker && streamed.text.includes(candidate.marker),
          ),
        error: streamed.error,
      };
    } catch (error) {
      return {
        marker: identity.marker,
        sessionId: identity.sessionId,
        status: 0,
        firstTokenMs: null,
        totalMs: performance.now() - startedAt,
        complete: false,
        markerValid: false,
        error: String(error),
      };
    }
  };

  if (config.profile === "warm") {
    phase = "warmup";
    await runTurn(identities[0]!);
    await waitForPersistence(db, schema, identities[0]!.sessionId, 2);
  }

  phase = "wave";
  const waveStartedAtMs = performance.now() - processStartedAt;
  const turns = await Promise.all(identities.map((identity) => runTurn(identity)));
  await Promise.all(
    identities.map((identity) => waitForPersistence(db, schema, identity.sessionId, 2)),
  );
  const waveEndedAtMs = performance.now() - processStartedAt;

  phase = "continuity";
  const continuityIdentity = identities[0]!;
  const persisted = await db
    .select({ content: schema.chatMessages.content })
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, continuityIdentity.sessionId));
  const priorMessages = persisted.map((row) => row.content);
  const continuity = await runTurn(continuityIdentity, [
    ...priorMessages,
    {
      id: `u-cont-${config.repetition}`,
      role: "user",
      parts: [{ type: "text", text: `continue ${continuityIdentity.marker}` }],
    },
  ]);
  await waitForPersistence(db, schema, continuityIdentity.sessionId, 4);

  const recoveryDeadline = performance.now() + config.recoveryMs;
  while (performance.now() < recoveryDeadline) {
    await Bun.sleep(Math.min(250, recoveryDeadline - performance.now()));
  }
  takeSample();
  clearInterval(sampler);

  const persistence = await verifyPersistence(db, schema, identities);
  let foreignSessionRejected = false;
  if (identities.length > 1) {
    try {
      await persistenceModule.ensureSession(
        identities[0]!.sessionId,
        identities[1]!.orgId,
        identities[1]!.user.id,
      );
    } catch {
      foreignSessionRejected = true;
    }
  } else {
    const foreign = await seedIdentities(db, schema, 1, "foreign");
    try {
      await persistenceModule.ensureSession(
        identities[0]!.sessionId,
        foreign[0]!.orgId,
        foreign[0]!.user.id,
      );
    } catch {
      foreignSessionRejected = true;
    }
  }

  const completed = turns.filter((turn) => turn.status === 200 && turn.complete);
  const observation = {
    schemaVersion: CHAT_PERFORMANCE_OBSERVATION_VERSION,
    kind: "chat-engine-performance-observation",
    benchmark: "controlled",
    id: [
      config.engine,
      config.form,
      config.profile,
      `c${config.concurrency}`,
      `r${config.repetition}`,
    ].join("-"),
    environment: {
      commit: textCommand(["git", "rev-parse", "HEAD"]),
      branch: textCommand(["git", "branch", "--show-current"]),
      bunVersion: Bun.version,
      platform: `${process.platform}-${process.arch}`,
      port: 3400,
      database: "isolated-pglite",
    },
    cell: {
      engine: config.engine,
      form: config.form,
      profile: config.profile,
      concurrency: config.concurrency,
      repetition: config.repetition,
      distribution: `${config.concurrency}-organizations-x-1-chat`,
    },
    timing: { waveStartedAtMs, waveEndedAtMs, recoveryMs: config.recoveryMs },
    memory: memoryCheckpoints(samples, { waveStartedAtMs, waveEndedAtMs }),
    eventLoopDelayMs: {
      p50: percentile(
        samples.map((sample) => sample.eventLoopDelayMs),
        0.5,
      ),
      p95: percentile(
        samples.map((sample) => sample.eventLoopDelayMs),
        0.95,
      ),
      p99: percentile(
        samples.map((sample) => sample.eventLoopDelayMs),
        0.99,
      ),
    },
    cpu: {
      userMicros: samples.at(-1)?.cpuUserMicros ?? 0,
      systemMicros: samples.at(-1)?.cpuSystemMicros ?? 0,
    },
    latency: {
      firstTokenMs: summarizeDurations(completed.flatMap((turn) => turn.firstTokenMs ?? [])),
      totalMs: summarizeDurations(completed.map((turn) => turn.totalMs)),
      throughputChatsPerSecond:
        completed.length / Math.max(0.001, (waveEndedAtMs - waveStartedAtMs) / 1_000),
    },
    outcomes: {
      requested: config.concurrency,
      completed: completed.length,
      rateLimited: turns.filter((turn) => turn.status === 429).length,
      serverErrors: turns.filter((turn) => turn.status >= 500 || turn.status === 0).length,
      incompleteStreams: turns.filter((turn) => !turn.complete).length,
      markerFailures: turns.filter((turn) => !turn.markerValid).length,
    },
    usage: {
      modelCalls: counters.waveModelCalls,
      toolCalls: counters.waveToolCalls,
      inputTokens: counters.inputTokens,
      outputTokens: counters.outputTokens,
    },
    persistence,
    continuity: {
      status: continuity.status,
      complete: continuity.complete,
      markerValid: continuity.markerValid,
      persistedMessageCount: persistence.bySession[continuityIdentity.sessionId] ?? 0,
    },
    isolation: { foreignSessionRejected },
    turns,
    samples,
  };
  await Bun.write(config.outputFile, `${JSON.stringify(observation, null, 2)}\n`);
  globalThis.fetch = originalFetch;
  await closeDb();
}

function configureIsolatedEnvironment(config: WorkerConfig): void {
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  process.env.PGLITE_DATA_DIR = config.databaseDir;
  process.env.FS_STORAGE_PATH = `${config.databaseDir}/storage`;
  process.env.BETTER_AUTH_SECRET = "performance-test-secret-at-least-32-characters";
  process.env.UPLOAD_SIGNING_SECRET = "performance-upload-secret-at-least-16";
  process.env.RUN_TOKEN_SECRET = "performance-run-secret-at-least-16";
  process.env.CONNECT_SESSION_SECRET = "performance-connect-secret-at-least-16";
  process.env.CONNECTION_ENCRYPTION_KEY = btoa("0123456789abcdef0123456789abcdef");
  process.env.PORT = "3400";
  process.env.APP_URL = "http://chat-pi-unified-engine-phase4.localhost:3400";
  process.env.TRUSTED_ORIGINS = process.env.APP_URL;
  process.env.CHAT_SELF_ORIGIN = "http://127.0.0.1:3400";
  process.env.CHAT_PI_MAX_CONCURRENCY = "128";
  process.env.LOG_LEVEL = "error";
}

function createControlledDispatch(options: {
  db: any;
  schema: any;
  sessionByMarker: Map<string, string>;
  identityByOrg: Map<string, any>;
  identityByMarker: Map<string, any>;
  onInference(usage: { inputTokens: number; outputTokens: number }): void;
}): FetchLike {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = normalizeFetchRequest(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/api/models") return modelsResponse();
    if (url.pathname === "/api/me/context") {
      const orgId = request.headers.get("x-org-id") ?? "";
      const identity = options.identityByOrg.get(orgId);
      return Response.json({
        user: identity?.user ?? { name: "Synthetic", email: "synthetic@example.test" },
        org: { role: "owner", name: identity?.orgName ?? "Synthetic", slug: identity?.orgSlug },
        connections: [],
        agents: [],
        skills: [],
        recent_runs: [],
      });
    }
    if (url.pathname.startsWith("/api/mcp/")) return mcpResponse(request);
    if (url.pathname.endsWith("/chat/completions")) {
      const body = await request.json();
      const serialized = JSON.stringify(body);
      const marker = [...options.sessionByMarker.keys()].find((candidate) =>
        serialized.includes(candidate),
      );
      if (!marker) return new Response("missing synthetic marker", { status: 400 });
      const inputTokens = 128;
      const outputTokens = 32;
      options.onInference({ inputTokens, outputTokens });
      const identity = options.identityByMarker.get(marker);
      const sessionId = options.sessionByMarker.get(marker)!;
      if (identity) {
        await options.db.insert(options.schema.llmUsage).values({
          source: "proxy",
          orgId: identity.orgId,
          userId: identity.user.id,
          chatSessionId: sessionId,
          model: "controlled-preset",
          realModel: "controlled-v1",
          api: "openai-completions",
          credentialSource: "org",
          inputTokens,
          outputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
          pricingStatus: "priced",
          durationMs: 160,
          requestId: crypto.randomUUID(),
        });
      }
      return controlledOpenAiSse(marker, inputTokens, outputTokens);
    }
    return new Response(`unexpected controlled dispatch: ${url.pathname}`, { status: 404 });
  };
}

function modelsResponse(): Response {
  return Response.json({
    object: "list",
    hasMore: false,
    data: [
      {
        id: "controlled-preset",
        label: "Controlled deterministic model",
        modelId: "controlled-v1",
        providerId: "controlled",
        apiShape: "openai-completions",
        enabled: true,
        is_default: true,
        input: ["text"],
        contextWindow: 32_768,
        maxTokens: 256,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        generation: {
          temperature: "unsupported",
          reasoning: { supported: "unsupported", adaptive: null, levels: {} },
        },
      },
    ],
  });
}

async function mcpResponse(request: Request): Promise<Response> {
  if (request.method === "GET") return new Response(null, { status: 405 });
  if (request.method === "DELETE") return new Response(null, { status: 202 });
  const message = (await request.json()) as { id?: unknown; method?: string };
  if (message.id === undefined) return new Response(null, { status: 202 });
  const result =
    message.method === "initialize"
      ? {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "chat-performance-controlled", version: "1" },
          instructions: "Controlled benchmark. Echo only the synthetic marker.",
        }
      : message.method === "tools/list"
        ? { tools: [] }
        : {};
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), {
    status: 200,
    headers: { "content-type": "application/json", "mcp-session-id": "perf-session" },
  });
}

function controlledOpenAiSse(marker: string, inputTokens: number, outputTokens: number): Response {
  const encoder = new TextEncoder();
  const fragments = (`controlled-response ${marker} ` + "x".repeat(160)).match(/.{1,8}/g) ?? [];
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await Bun.sleep(20);
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ id: "controlled", object: "chat.completion.chunk", model: "controlled-v1", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
        ),
      );
      for (const fragment of fragments) {
        await Bun.sleep(5);
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ id: "controlled", object: "chat.completion.chunk", model: "controlled-v1", choices: [{ index: 0, delta: { content: fragment }, finish_reason: null }] })}\n\n`,
          ),
        );
      }
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ id: "controlled", object: "chat.completion.chunk", model: "controlled-v1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } })}\n\ndata: [DONE]\n\n`,
        ),
      );
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function readUiStream(
  response: Response,
  startedAt: number,
): Promise<{ firstTokenMs: number | null; complete: boolean; text: string; error: string | null }> {
  if (!response.body) {
    return { firstTokenMs: null, complete: false, text: "", error: await response.text() };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let complete = false;
  let firstTokenMs: number | null = null;
  let error: string | null = null;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (parsed.type === "text-delta") {
        if (firstTokenMs === null) firstTokenMs = performance.now() - startedAt;
        text += String(parsed.delta ?? "");
      }
      if (parsed.type === "finish") complete = true;
      if (parsed.type === "error") error = String(parsed.errorText ?? "unknown stream error");
    }
  }
  return { firstTokenMs, complete, text, error };
}

function conversation(form: ConversationForm, marker: string): any[] {
  if (form === "S") {
    return [{ id: `u-${marker}`, role: "user", parts: [{ type: "text", text: `echo ${marker}` }] }];
  }
  return [
    { id: `u0-${marker}`, role: "user", parts: [{ type: "text", text: `context ${marker}` }] },
    {
      id: `a0-${marker}`,
      role: "assistant",
      parts: [
        { type: "reasoning", text: "controlled reasoning" },
        { type: "step-start" },
        {
          type: "dynamic-tool",
          toolName: "controlled_echo",
          toolCallId: `call-${marker}`,
          state: "output-available",
          input: { marker },
          output: { marker, ok: true },
        },
        { type: "step-start" },
        { type: "text", text: `historical result ${marker}` },
      ],
    },
    { id: `u1-${marker}`, role: "user", parts: [{ type: "text", text: "history question 1" }] },
    { id: `a1-${marker}`, role: "assistant", parts: [{ type: "text", text: "history answer 1" }] },
    { id: `u2-${marker}`, role: "user", parts: [{ type: "text", text: "history question 2" }] },
    { id: `a2-${marker}`, role: "assistant", parts: [{ type: "text", text: "history answer 2" }] },
    { id: `u3-${marker}`, role: "user", parts: [{ type: "text", text: "history question 3" }] },
    { id: `a3-${marker}`, role: "assistant", parts: [{ type: "text", text: "history answer 3" }] },
    { id: `u4-${marker}`, role: "user", parts: [{ type: "text", text: "history question 4" }] },
    { id: `a4-${marker}`, role: "assistant", parts: [{ type: "text", text: "history answer 4" }] },
    {
      id: `u5-${marker}`,
      role: "user",
      parts: [{ type: "text", text: `echo ${marker}` }],
    },
  ];
}

async function seedIdentities(
  db: any,
  schema: any,
  count: number,
  prefix = "perf",
): Promise<SyntheticIdentity[]> {
  const identities = Array.from({ length: count }, (_, index) => {
    const suffix = `${prefix}-${String(index + 1).padStart(4, "0")}-${crypto.randomUUID().slice(0, 8)}`;
    const userId = `usr-${suffix}`;
    const orgId = crypto.randomUUID();
    return {
      marker: `ORG${String(index + 1).padStart(4, "0")}_USER${String(index + 1).padStart(4, "0")}`,
      user: { id: userId, email: `${suffix}@example.test`, name: `Synthetic ${index + 1}` },
      orgId,
      orgName: `Synthetic Org ${index + 1}`,
      orgSlug: suffix,
      appId: `app_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
      sessionId: `chs_${crypto.randomUUID().replaceAll("-", "")}`,
    };
  });
  await db.insert(schema.user).values(
    identities.map((identity) => ({
      id: identity.user.id,
      name: identity.user.name,
      email: identity.user.email,
      emailVerified: true,
      realm: "platform",
    })),
  );
  await db.insert(schema.organizations).values(
    identities.map((identity) => ({
      id: identity.orgId,
      name: identity.orgName,
      slug: identity.orgSlug,
      createdBy: identity.user.id,
    })),
  );
  await db.insert(schema.organizationMembers).values(
    identities.map((identity) => ({
      orgId: identity.orgId,
      userId: identity.user.id,
      role: "owner",
    })),
  );
  await db.insert(schema.applications).values(
    identities.map((identity) => ({
      id: identity.appId,
      orgId: identity.orgId,
      name: "Synthetic Default",
      isDefault: true,
      createdBy: identity.user.id,
    })),
  );
  return identities;
}

async function waitForPersistence(db: any, schema: any, sessionId: string, minimum: number) {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const rows = await db
      .select({ id: schema.chatMessages.messageId })
      .from(schema.chatMessages)
      .where(
        (await import("../packages/db/node_modules/drizzle-orm")).eq(
          schema.chatMessages.sessionId,
          sessionId,
        ),
      );
    if (rows.length >= minimum) return;
    if (performance.now() >= deadline) throw new Error(`persistence timeout for ${sessionId}`);
    await Bun.sleep(15);
  }
}

async function verifyPersistence(db: any, schema: any, identities: any[]) {
  const { inArray } = await import("../packages/db/node_modules/drizzle-orm");
  const sessionIds = identities.map((identity) => identity.sessionId);
  const messages = await db
    .select()
    .from(schema.chatMessages)
    .where(inArray(schema.chatMessages.sessionId, sessionIds));
  const usage = await db
    .select()
    .from(schema.llmUsage)
    .where(inArray(schema.llmUsage.chatSessionId, sessionIds));
  const bySession: Record<string, number> = {};
  let structuredParts = 0;
  for (const message of messages) {
    bySession[message.sessionId] = (bySession[message.sessionId] ?? 0) + 1;
    const content = message.content as { parts?: unknown[] };
    structuredParts += Array.isArray(content.parts) ? content.parts.length : 0;
  }
  const ownershipValid = usage.every((row: any) => {
    const identity = identities.find((candidate) => candidate.sessionId === row.chatSessionId);
    return identity && row.orgId === identity.orgId && row.userId === identity.user.id;
  });
  return {
    messageCount: messages.length,
    structuredPartCount: structuredParts,
    usageRows: usage.length,
    usageOwnershipValid: ownershipValid,
    bySession,
  };
}

function workerConfigFromEnvironment(): WorkerConfig {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing worker environment variable ${name}`);
    return value;
  };
  return {
    engine: required("CHAT_PERF_ENGINE") as Engine,
    form: required("CHAT_PERF_FORM") as ConversationForm,
    profile: required("CHAT_PERF_PROFILE") as Profile,
    concurrency: Number(required("CHAT_PERF_CONCURRENCY")),
    repetition: Number(required("CHAT_PERF_REPETITION")),
    recoveryMs: Number(required("CHAT_PERF_RECOVERY_MS")),
    outputFile: required("CHAT_PERF_OUTPUT_FILE"),
    databaseDir: required("CHAT_PERF_DATABASE_DIR"),
  };
}

function csvOption(args: string[], name: string, fallback: string[]): string[] {
  return stringOption(args, name, fallback.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function numberOption(args: string[], name: string, fallback: number): number {
  return Number(stringOption(args, name, String(fallback)));
}

function stringOption(args: string[], name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function textCommand(command: string[]): string {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "unknown";
}
