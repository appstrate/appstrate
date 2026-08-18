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
  parseDotEnvValue,
  summarizeDurations,
  summarizeWaveActivity,
  waitForWorkerExit,
  type MemorySample,
} from "./chat-engine-performance-lib.ts";
import type { ChatEnv } from "../packages/module-chat/src/prompt.ts";

type Engine = "ai-sdk" | "pi";
type ConversationForm = "S" | "H" | "T";
type Profile = "cold" | "warm";
type Benchmark = "controlled" | "mistral-real";

interface WorkerConfig {
  benchmark: Benchmark;
  engine: Engine;
  form: ConversationForm;
  profile: Profile;
  concurrency: number;
  organizations: number;
  piMaxConcurrency: number;
  repetition: number;
  recoveryMs: number;
  outputFile: string;
  databaseDir: string;
  providerEnvFile: string | null;
  providerModelId: string;
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
  cookie?: string;
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
  if (command !== "controlled" && command !== "mistral") {
    throw new Error(`Unsupported benchmark command: ${command}`);
  }
  const benchmark: Benchmark = command === "mistral" ? "mistral-real" : "controlled";
  const engines = csvOption(args, "engines", ["ai-sdk", "pi"]) as Engine[];
  const forms = csvOption(args, "forms", ["S", "H"]) as ConversationForm[];
  const profiles = csvOption(args, "profiles", ["cold", "warm"]) as Profile[];
  const concurrencies = csvOption(args, "concurrency", ["1", "10", "30", "60", "64", "100"])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0);
  const repetitions = numberOption(args, "repetitions", 5);
  const organizationsOption = numberOption(args, "organizations", 0);
  const piMaxConcurrency = numberOption(args, "pi-cap", 128);
  const recoveryMs = numberOption(args, "recovery-ms", 120_000);
  const cellTimeoutMs = numberOption(args, "cell-timeout-ms", 15 * 60_000);
  const outputDir = stringOption(args, "output", `artifacts/chat-engine-performance/${command}`);
  const providerEnvFile = command === "mistral" ? stringOption(args, "env-file", "") : "";
  const providerModelId = stringOption(args, "model", "mistral-small-2603");
  if (command === "mistral" && !providerEnvFile) {
    throw new Error("The Mistral benchmark requires --env-file=/absolute/path/to/.env");
  }
  if (command === "mistral") {
    const providerEnv = await Bun.file(providerEnvFile).text();
    if (!parseDotEnvValue(providerEnv, "MISTRAL_API_KEY")) {
      throw new Error("MISTRAL_API_KEY is missing or empty in the provider env file");
    }
  }

  await $`mkdir -p ${outputDir}`.quiet();
  const commit = textCommand(["git", "rev-parse", "HEAD"]);
  const startedAt = new Date().toISOString();
  const files: string[] = [];
  for (const form of forms) {
    for (const concurrency of concurrencies) {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        for (const profile of profiles) {
          for (const engine of engines) {
            const organizations = organizationsOption || concurrency;
            if (organizations > concurrency || concurrency % organizations !== 0) {
              throw new Error("organizations must divide concurrency and cannot exceed it");
            }
            const id = [
              engine,
              form,
              profile,
              `c${concurrency}`,
              `o${organizations}`,
              `r${repetition}`,
            ].join("-");
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
                CHAT_PERF_ORGANIZATIONS: String(organizations),
                CHAT_PERF_PI_MAX_CONCURRENCY: String(piMaxConcurrency),
                CHAT_PERF_REPETITION: String(repetition),
                CHAT_PERF_RECOVERY_MS: String(recoveryMs),
                CHAT_PERF_OUTPUT_FILE: outputFile,
                CHAT_PERF_DATABASE_DIR: databaseDir,
                CHAT_PERF_BENCHMARK: benchmark,
                CHAT_PERF_PROVIDER_ENV_FILE: providerEnvFile,
                CHAT_PERF_PROVIDER_MODEL_ID: providerModelId,
              },
              stdout: "inherit",
              stderr: "inherit",
            });
            const exitCode = await waitForWorkerExit(child, cellTimeoutMs);
            if (exitCode !== 0) throw new Error(`Benchmark worker failed for ${id}`);
            const observation = (await Bun.file(outputFile).json()) as {
              outcomes: {
                requested: number;
                completed: number;
                rateLimited: number;
                incompleteStreams: number;
                markerFailures: number;
              };
              isolation: { foreignSessionRejected: boolean };
              continuity: { complete: boolean; markerValid: boolean };
              usage: {
                modelCalls: number;
                toolCalls: number;
                inputTokens: number;
                outputTokens: number;
              };
              persistence: { bySession: Record<string, number> };
              turns: Array<{ sessionId: string; status: number }>;
            };
            const expectedCompleted =
              engine === "pi" ? Math.min(concurrency, piMaxConcurrency) : concurrency;
            const expectedRateLimited = concurrency - expectedCompleted;
            const expectedUsage =
              form === "T"
                ? {
                    modelCalls: expectedCompleted * 2,
                    toolCalls: expectedCompleted,
                    inputTokens: expectedCompleted * 288,
                    outputTokens: expectedCompleted * 48,
                  }
                : {
                    modelCalls: expectedCompleted,
                    toolCalls: 0,
                    inputTokens: expectedCompleted * 128,
                    outputTokens: expectedCompleted * 32,
                  };
            const rejectedMessagePersisted = observation.turns.some(
              (turn) =>
                turn.status === 429 && (observation.persistence.bySession[turn.sessionId] ?? 0) > 0,
            );
            if (
              benchmark === "controlled" &&
              (observation.outcomes.completed !== expectedCompleted ||
                observation.outcomes.rateLimited !== expectedRateLimited ||
                observation.outcomes.incompleteStreams !== 0 ||
                observation.outcomes.markerFailures !== 0 ||
                !observation.isolation.foreignSessionRejected ||
                !observation.continuity.complete ||
                !observation.continuity.markerValid ||
                observation.usage.modelCalls !== expectedUsage.modelCalls ||
                observation.usage.toolCalls !== expectedUsage.toolCalls ||
                observation.usage.inputTokens !== expectedUsage.inputTokens ||
                observation.usage.outputTokens !== expectedUsage.outputTokens ||
                rejectedMessagePersisted)
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
    benchmark,
    startedAt,
    completedAt: new Date().toISOString(),
    commit,
    bunVersion: Bun.version,
    command: Bun.argv.join(" "),
    parameters: {
      engines,
      forms,
      profiles,
      concurrencies,
      repetitions,
      organizations: organizationsOption || "one-per-chat",
      piMaxConcurrency,
      recoveryMs,
      cellTimeoutMs,
      provider: command === "mistral" ? "mistral-api-key" : "deterministic",
      modelId: command === "mistral" ? providerModelId : "controlled-v1",
    },
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
  const { db } = dbModule;
  const originalFetch = globalThis.fetch;
  const identities = await seedIdentities(
    db,
    schema,
    config.concurrency,
    "perf",
    config.organizations,
  );
  const realAppstrate = config.benchmark === "mistral-real";
  let realServer: ReturnType<typeof Bun.serve> | null = null;
  if (realAppstrate) {
    await seedRealMistralContext(db, schema, identities, config);
    process.env.CHAT_PI_ENGINE_ORG_IDS =
      config.engine === "pi"
        ? [...new Set(identities.map((identity) => identity.orgId))].join(",")
        : "";
    const apiEntrypoint = new URL("../apps/api/src/index.ts", import.meta.url).href;
    const serverConfig = (
      (await import(apiEntrypoint)) as {
        default: Parameters<typeof Bun.serve>[0];
      }
    ).default;
    realServer = Bun.serve(serverConfig);
    await waitForHealthyApi(originalFetch, "http://127.0.0.1:3400/health");
  }
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
    providerStatuses: { ok: 0, rateLimited: 0, serverError: 0, otherError: 0 },
  };

  const sharedDispatchOptions = {
    db,
    schema,
    sessionByMarker,
    identityByOrg,
    identityByMarker,
    form: config.form,
    onToolCall: () => {
      if (phase === "wave") counters.waveToolCalls += 1;
    },
    onInference: (usage: { inputTokens: number; outputTokens: number }) => {
      if (phase !== "wave") return;
      counters.waveModelCalls += 1;
      counters.inputTokens += usage.inputTokens;
      counters.outputTokens += usage.outputTokens;
    },
  };
  const dispatch = realAppstrate
    ? originalFetch.bind(globalThis)
    : createControlledDispatch(sharedDispatchOptions);
  if (!realAppstrate) globalThis.fetch = dispatch as typeof fetch;

  const deps = {
    dispatch,
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
    const identity =
      identityByMarker.get(context.req.header("x-performance-marker") ?? "") ??
      identityByOrg.get(context.req.param("orgId"));
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
      const headers = {
        "content-type": "application/json",
        "x-application-id": identity.appId,
        "x-org-id": identity.orgId,
        "x-performance-marker": identity.marker,
        ...(identity.cookie ? { cookie: identity.cookie } : {}),
      };
      const requestInit = {
        method: "POST",
        headers,
        body: JSON.stringify({ id: identity.sessionId, messages }),
      };
      const response = realAppstrate
        ? await originalFetch("http://127.0.0.1:3400/api/chat", requestInit)
        : await app.request(`/api/chat/${identity.orgId}`, requestInit);
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

  const usageIdsBeforeWave = realAppstrate
    ? await selectUsageIds(db, schema, identities)
    : new Set<string>();
  phase = "wave";
  const waveStartedAtMs = performance.now() - processStartedAt;
  const turns = await Promise.all(identities.map((identity) => runTurn(identity)));
  await Promise.all(
    identities.map((identity, index) =>
      turns[index]?.status === 200
        ? waitForPersistence(db, schema, identity.sessionId, 2)
        : Promise.resolve(),
    ),
  );
  if (realAppstrate) {
    const expectedUsageRows =
      usageIdsBeforeWave.size +
      turns.filter((turn) => turn.status === 200 && turn.complete && turn.error === null).length;
    await waitForUsageCount(db, schema, identities, expectedUsageRows);
    const waveUsage = await selectNewUsage(db, schema, identities, usageIdsBeforeWave);
    counters.waveModelCalls = waveUsage.length;
    counters.inputTokens = waveUsage.reduce(
      (total: number, row: any) => total + (row.inputTokens ?? 0) + (row.cacheReadTokens ?? 0),
      0,
    );
    counters.outputTokens = waveUsage.reduce(
      (total: number, row: any) => total + (row.outputTokens ?? 0),
      0,
    );
    counters.providerStatuses.ok = waveUsage.length;
  }
  const waveEndedAtMs = performance.now() - processStartedAt;

  phase = "continuity";
  const usageCountBeforeContinuity = realAppstrate
    ? (await selectUsageIds(db, schema, identities)).size
    : 0;
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
      parts: [
        {
          type: "text",
          text: `Réponds uniquement avec ce code de vérification, sans outil : ${continuityIdentity.marker}`,
        },
      ],
    },
  ]);
  await waitForPersistence(db, schema, continuityIdentity.sessionId, 4);
  if (
    realAppstrate &&
    continuity.status === 200 &&
    continuity.complete &&
    continuity.error === null
  ) {
    await waitForUsageCount(db, schema, identities, usageCountBeforeContinuity + 1);
  }

  const recoveryDeadline = performance.now() + config.recoveryMs;
  while (performance.now() < recoveryDeadline) {
    await Bun.sleep(Math.min(250, recoveryDeadline - performance.now()));
  }
  takeSample();
  clearInterval(sampler);

  const persistence = await verifyPersistence(db, schema, identities);
  let foreignSessionRejected = false;
  if (identities.length > 1) {
    const foreignIdentity =
      identities.find((identity) => identity.orgId !== identities[0]!.orgId) ?? identities[1]!;
    try {
      await persistenceModule.ensureSession(
        identities[0]!.sessionId,
        foreignIdentity.orgId,
        foreignIdentity.user.id,
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

  if (!realAppstrate) globalThis.fetch = originalFetch;

  const completed = turns.filter((turn) => turn.status === 200 && turn.complete);
  const waveActivity = summarizeWaveActivity(samples, { waveStartedAtMs, waveEndedAtMs });
  const observation = {
    schemaVersion: CHAT_PERFORMANCE_OBSERVATION_VERSION,
    kind: "chat-engine-performance-observation",
    benchmark: config.benchmark,
    id: [
      config.engine,
      config.form,
      config.profile,
      `c${config.concurrency}`,
      `o${config.organizations}`,
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
      distribution: `${config.organizations}-organizations-x-${config.concurrency / config.organizations}-chats`,
    },
    timing: { waveStartedAtMs, waveEndedAtMs, recoveryMs: config.recoveryMs },
    memory: memoryCheckpoints(samples, { waveStartedAtMs, waveEndedAtMs }),
    eventLoopDelayMs: waveActivity.eventLoopDelayMs,
    cpu: waveActivity.cpu,
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
      incompleteStreams: turns.filter((turn) => turn.status === 200 && !turn.complete).length,
      markerFailures: turns.filter((turn) => turn.status === 200 && !turn.markerValid).length,
    },
    usage: {
      modelCalls: counters.waveModelCalls,
      toolCalls: counters.waveToolCalls,
      inputTokens: counters.inputTokens,
      outputTokens: counters.outputTokens,
    },
    provider: {
      id: config.benchmark === "mistral-real" ? "mistral-api-key" : "deterministic",
      modelId: config.benchmark === "mistral-real" ? config.providerModelId : "controlled-v1",
      statuses: counters.providerStatuses,
    },
    persistence,
    continuity: {
      status: continuity.status,
      complete: continuity.complete,
      markerValid: continuity.markerValid,
      persistedMessageCount: persistence.bySession[continuityIdentity.sessionId] ?? 0,
    },
    isolation: { foreignSessionRejected },
    teardown: { databaseRelease: "process-exit-after-verification" },
    turns,
    samples,
  };
  await Bun.write(config.outputFile, `${JSON.stringify(observation, null, 2)}\n`);
  realServer?.stop(true);
  process.exit(0);
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
  process.env.APP_URL = "http://localhost:3400";
  process.env.TRUSTED_ORIGINS = process.env.APP_URL;
  process.env.CHAT_SELF_ORIGIN = "http://127.0.0.1:3400";
  process.env.CHAT_PI_MAX_CONCURRENCY = String(config.piMaxConcurrency);
  process.env.MODULES =
    "mcp,core-providers,@appstrate/module-codex,@appstrate/module-claude-code,@appstrate/module-chat";
  process.env.OAUTH_REFRESH_WORKER_ENABLED = "false";
  process.env.LOG_LEVEL = "error";
}

function createControlledDispatch(options: {
  db: any;
  schema: any;
  sessionByMarker: Map<string, string>;
  identityByOrg: Map<string, any>;
  identityByMarker: Map<string, any>;
  form: ConversationForm;
  onToolCall(): void;
  onInference(usage: { inputTokens: number; outputTokens: number }): void;
}): FetchLike {
  const awaitingToolResult = new Set<string>();
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
    if (url.pathname.startsWith("/api/mcp/")) {
      return mcpResponse(request, {
        enableControlledTool: options.form === "T",
        onToolCall: options.onToolCall,
      });
    }
    if (url.pathname.endsWith("/chat/completions")) {
      const body = await request.json();
      const serialized = JSON.stringify(body);
      const marker = [...options.sessionByMarker.keys()].find((candidate) =>
        serialized.includes(candidate),
      );
      if (!marker) return new Response("missing synthetic marker", { status: 400 });
      const toolStep = options.form === "T" && !awaitingToolResult.has(marker);
      const inputTokens = toolStep ? 128 : options.form === "T" ? 160 : 128;
      const outputTokens = toolStep ? 16 : 32;
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
      if (toolStep) {
        awaitingToolResult.add(marker);
        return controlledOpenAiToolSse(marker, inputTokens, outputTokens);
      }
      awaitingToolResult.delete(marker);
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

async function mcpResponse(
  request: Request,
  options: { enableControlledTool: boolean; onToolCall(): void },
): Promise<Response> {
  if (request.method === "GET") return new Response(null, { status: 405 });
  if (request.method === "DELETE") return new Response(null, { status: 202 });
  const message = (await request.json()) as {
    id?: unknown;
    method?: string;
    params?: { name?: string; arguments?: { marker?: string } };
  };
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
        ? {
            tools: options.enableControlledTool
              ? [
                  {
                    name: "controlled_echo",
                    description: "Return the supplied synthetic isolation marker.",
                    inputSchema: {
                      type: "object",
                      properties: { marker: { type: "string" } },
                      required: ["marker"],
                      additionalProperties: false,
                    },
                  },
                ]
              : [],
          }
        : message.method === "tools/call" &&
            options.enableControlledTool &&
            message.params?.name === "controlled_echo"
          ? controlledToolResult(message.params.arguments?.marker, options.onToolCall)
          : {};
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), {
    status: 200,
    headers: { "content-type": "application/json", "mcp-session-id": "perf-session" },
  });
}

function controlledToolResult(marker: string | undefined, onToolCall: () => void) {
  onToolCall();
  const output = { marker: marker ?? "missing-marker", ok: marker !== undefined };
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output,
    isError: marker === undefined,
  };
}

function controlledOpenAiToolSse(
  marker: string,
  inputTokens: number,
  outputTokens: number,
): Response {
  const encoder = new TextEncoder();
  const callId = `call_${marker.toLowerCase()}`;
  const chunks = [
    {
      id: "controlled-tool",
      object: "chat.completion.chunk",
      model: "controlled-v1",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name: "controlled_echo", arguments: JSON.stringify({ marker }) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "controlled-tool",
      object: "chat.completion.chunk",
      model: "controlled-v1",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    },
  ];
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        await Bun.sleep(20);
        for (const chunk of chunks)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
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
    return [
      {
        id: `u-${marker}`,
        role: "user",
        parts: [
          {
            type: "text",
            text: `Réponds uniquement avec ce code de vérification, sans outil : ${marker}`,
          },
        ],
      },
    ];
  }
  const history = [
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
      parts: [
        {
          type: "text",
          text:
            form === "T"
              ? `Call controlled_echo once with marker ${marker}, then echo its result.`
              : `Réponds uniquement avec ce code de vérification, sans outil : ${marker}`,
        },
      ],
    },
  ];
  return history;
}

async function seedIdentities(
  db: any,
  schema: any,
  count: number,
  prefix = "perf",
  organizationCount = count,
): Promise<SyntheticIdentity[]> {
  if (organizationCount > count || count % organizationCount !== 0) {
    throw new Error("organizationCount must divide count and cannot exceed it");
  }
  const chatsPerOrganization = count / organizationCount;
  const organizations = Array.from({ length: organizationCount }, (_, index) => ({
    id: crypto.randomUUID(),
    name: `Synthetic Org ${index + 1}`,
    slug: `${prefix}-org-${String(index + 1).padStart(4, "0")}-${crypto.randomUUID().slice(0, 8)}`,
    appId: `app_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
  }));
  const identities = Array.from({ length: count }, (_, index) => {
    const organizationIndex = Math.floor(index / chatsPerOrganization);
    const organization = organizations[organizationIndex]!;
    const suffix = `${prefix}-${String(index + 1).padStart(4, "0")}-${crypto.randomUUID().slice(0, 8)}`;
    const userId = `usr-${suffix}`;
    return {
      marker: `ORG${String(organizationIndex + 1).padStart(4, "0")}_USER${String(index + 1).padStart(4, "0")}`,
      user: { id: userId, email: `${suffix}@example.test`, name: `Synthetic ${index + 1}` },
      orgId: organization.id,
      orgName: organization.name,
      orgSlug: organization.slug,
      appId: organization.appId,
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
    organizations.map((organization, index) => ({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      createdBy: identities[index * chatsPerOrganization]!.user.id,
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
    organizations.map((organization, index) => ({
      id: organization.appId,
      orgId: organization.id,
      name: "Synthetic Default",
      isDefault: true,
      createdBy: identities[index * chatsPerOrganization]!.user.id,
    })),
  );
  return identities;
}

async function seedRealMistralContext(
  db: any,
  schema: any,
  identities: SyntheticIdentity[],
  config: WorkerConfig,
): Promise<void> {
  const [{ encryptCredentials }, { eq }] = await Promise.all([
    import("@appstrate/connect"),
    import("../packages/db/node_modules/drizzle-orm"),
  ]);
  const apiKey = await loadProviderKey(config);
  const secret = process.env.BETTER_AUTH_SECRET!;
  await db.insert(schema.profiles).values(
    identities.map((identity) => ({
      id: identity.user.id,
      displayName: identity.user.name,
      language: "fr",
    })),
  );
  for (const identity of identities) {
    const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().slice(0, 16);
    identity.cookie = await signBenchmarkSessionCookie(token, secret);
    await db.insert(schema.session).values({
      id: crypto.randomUUID(),
      token,
      userId: identity.user.id,
      expiresAt: new Date(Date.now() + 3_600_000),
      realm: "platform",
    });
  }

  for (const orgId of [...new Set(identities.map((identity) => identity.orgId))]) {
    const owner = identities.find((identity) => identity.orgId === orgId)!;
    const [credential] = await db
      .insert(schema.modelProviderCredentials)
      .values({
        orgId,
        label: "Mistral performance key",
        providerId: "mistral",
        credentialsEncrypted: encryptCredentials({ kind: "api_key", apiKey }),
        availableModelIds: [config.providerModelId],
        createdBy: owner.user.id,
      })
      .returning();
    const [model] = await db
      .insert(schema.orgModels)
      .values({
        orgId,
        credentialId: credential.id,
        label: `Mistral performance ${config.providerModelId}`,
        modelId: config.providerModelId,
        input: ["text"],
        contextWindow: 32_768,
        maxTokens: 256,
        enabled: true,
        createdBy: owner.user.id,
      })
      .returning();
    await db
      .update(schema.organizations)
      .set({ defaultModelId: model.id })
      .where(eq(schema.organizations.id, orgId));
  }
}

async function signBenchmarkSessionCookie(token: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
  const signature = btoa(String.fromCharCode(...new Uint8Array(signed)));
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

async function selectUsageIds(db: any, schema: any, identities: SyntheticIdentity[]) {
  const { inArray } = await import("../packages/db/node_modules/drizzle-orm");
  const rows = await db
    .select({ id: schema.llmUsage.id })
    .from(schema.llmUsage)
    .where(
      inArray(
        schema.llmUsage.chatSessionId,
        identities.map((identity) => identity.sessionId),
      ),
    );
  return new Set<string>(rows.map((row: { id: string }) => row.id));
}

async function selectNewUsage(
  db: any,
  schema: any,
  identities: SyntheticIdentity[],
  existingIds: Set<string>,
) {
  const { inArray } = await import("../packages/db/node_modules/drizzle-orm");
  const rows = await db
    .select()
    .from(schema.llmUsage)
    .where(
      inArray(
        schema.llmUsage.chatSessionId,
        identities.map((identity) => identity.sessionId),
      ),
    );
  return rows.filter((row: { id: string }) => !existingIds.has(row.id));
}

async function waitForUsageCount(
  db: any,
  schema: any,
  identities: SyntheticIdentity[],
  minimum: number,
): Promise<void> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const count = (await selectUsageIds(db, schema, identities)).size;
    if (count >= minimum) return;
    if (performance.now() >= deadline) {
      throw new Error(`usage persistence timeout: expected ${minimum}, observed ${count}`);
    }
    await Bun.sleep(25);
  }
}

async function waitForHealthyApi(fetchImpl: FetchLike, url: string): Promise<void> {
  const deadline = performance.now() + 30_000;
  for (;;) {
    try {
      const response = await fetchImpl(url);
      if (response.ok) return;
    } catch {
      // The socket is expected to refuse connections until Bun.serve binds it.
    }
    if (performance.now() >= deadline)
      throw new Error(`Appstrate API did not become healthy: ${url}`);
    await Bun.sleep(50);
  }
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

async function loadProviderKey(config: WorkerConfig): Promise<string> {
  if (!config.providerEnvFile) throw new Error("Missing provider env file");
  const contents = await Bun.file(config.providerEnvFile).text();
  const key = parseDotEnvValue(contents, "MISTRAL_API_KEY");
  if (!key) throw new Error("MISTRAL_API_KEY is missing or empty in the provider env file");
  return key;
}

function workerConfigFromEnvironment(): WorkerConfig {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing worker environment variable ${name}`);
    return value;
  };
  return {
    benchmark: required("CHAT_PERF_BENCHMARK") as Benchmark,
    engine: required("CHAT_PERF_ENGINE") as Engine,
    form: required("CHAT_PERF_FORM") as ConversationForm,
    profile: required("CHAT_PERF_PROFILE") as Profile,
    concurrency: Number(required("CHAT_PERF_CONCURRENCY")),
    organizations: Number(required("CHAT_PERF_ORGANIZATIONS")),
    piMaxConcurrency: Number(required("CHAT_PERF_PI_MAX_CONCURRENCY")),
    repetition: Number(required("CHAT_PERF_REPETITION")),
    recoveryMs: Number(required("CHAT_PERF_RECOVERY_MS")),
    outputFile: required("CHAT_PERF_OUTPUT_FILE"),
    databaseDir: required("CHAT_PERF_DATABASE_DIR"),
    providerEnvFile: process.env.CHAT_PERF_PROVIDER_ENV_FILE || null,
    providerModelId: process.env.CHAT_PERF_PROVIDER_MODEL_ID || "mistral-small-2603",
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
