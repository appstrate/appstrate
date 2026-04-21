// SPDX-License-Identifier: Apache-2.0

/**
 * Parity E2E — proves the Appstrate adapters honour the runtime contract
 * end-to-end. Scenario:
 *
 *   1. A scripted "adapter" yields a canonical event sequence.
 *   2. AppstrateContainerRunner bridges the adapter to AppstrateEventSink
 *      + AppstrateContextProvider.
 *   3. The run produces the same RunResult as the runtime's MockRunner
 *      would, driven by the same event stream.
 *   4. run_logs rows + memory inserts line up with the DB side-effects
 *      an external runtime consumer would see via an equivalent sink
 *      implementation.
 *
 * A separate block verifies the @appstrate/environment prelude renders
 * against a realistic PromptView produced by the context provider +
 * buildPromptView.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { addPackageMemories } from "../../../src/services/state/package-memories.ts";
import { AppstrateEventSink } from "../../../src/services/adapters/appstrate-event-sink.ts";
import { AppstrateContextProvider } from "../../../src/services/adapters/appstrate-context-provider.ts";
import {
  AppstrateContainerRunner,
  mapRunMessageToAfpsEvent,
} from "../../../src/services/adapters/appstrate-container-runner.ts";
import { AppstratePreludeResolver } from "../../../src/services/adapters/appstrate-prelude-resolver.ts";
import {
  APPSTRATE_ENVIRONMENT_NAME,
  APPSTRATE_ENVIRONMENT_VERSION,
  buildAppstratePreludeFlags,
} from "../../../src/services/adapters/appstrate-environment-prompt.ts";
import type {
  PromptContext,
  RunAdapter,
  RunMessage,
  UploadedFile,
} from "../../../src/services/adapters/types.ts";
import type { AfpsEvent } from "@appstrate/afps-runtime/types";
import { reduceEvents } from "@appstrate/afps-runtime/runner";
import { buildPromptView, renderPrompt } from "@appstrate/afps-runtime/bundle";
import type { LoadedBundle } from "@appstrate/afps-runtime/bundle";
import { db } from "@appstrate/db/client";
import { runLogs } from "@appstrate/db/schema";
import { eq, and, asc } from "drizzle-orm";
import type { Actor } from "../../../src/lib/actor.ts";

class ScriptedAdapter implements RunAdapter {
  constructor(private readonly script: RunMessage[]) {}
  async *execute(
    _runId: string,
    _ctx: PromptContext,
    _timeout: number,
    _pkg?: Buffer,
    _signal?: AbortSignal,
    _files?: UploadedFile[],
  ): AsyncGenerator<RunMessage> {
    for (const m of this.script) yield m;
  }
}

function baseBundle(): LoadedBundle {
  return {
    manifest: {
      name: "@testorg/parity",
      version: "1.0.0",
      type: "agent",
      schemaVersion: "1.2",
    },
    prompt: "Parity agent body: topic={{input.topic}}",
    files: {},
    compressedSize: 0,
    decompressedSize: 0,
  };
}

function basePromptContext(runId: string): PromptContext {
  return {
    schemaVersion: "1.2",
    runId,
    rawPrompt: "Parity agent body: topic={{input.topic}}",
    tokens: {},
    config: {},
    previousState: null,
    input: { topic: "parity" },
    schemas: {},
    providers: [],
    memories: [],
    llmModel: "test",
    llmConfig: {
      api: "anthropic-messages",
      modelId: "test",
      apiKey: "test",
      baseUrl: "",
      input: ["text"],
      contextWindow: 0,
      maxTokens: 0,
      reasoning: false,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      } as PromptContext["llmConfig"]["cost"],
    },
    proxyUrl: null,
    timeout: 60,
    availableTools: [],
    availableSkills: [],
    toolDocs: [],
  };
}

describe("Parity E2E — full adapter stack", () => {
  let ctx: TestContext;
  const agentId = "@testorg/parity";
  let actor: Actor;
  let runId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    actor = { type: "member", id: ctx.user.id };
    await seedAgent({ id: agentId, orgId: ctx.orgId, createdBy: ctx.user.id });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, agentId);
    const run = await seedRun({
      packageId: agentId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      dashboardUserId: ctx.user.id,
      status: "running",
    });
    runId = run.id;
  });

  it("AppstrateContainerRunner → AppstrateEventSink produces the same RunResult the runtime reducer would compute", async () => {
    const script: RunMessage[] = [
      { type: "progress", message: "booting", level: "info" },
      { type: "add_memory", content: "learned A" },
      { type: "add_memory", content: "learned B" },
      { type: "output", data: { deliverable: "shipped" } },
      { type: "set_state", data: { counter: 7 } },
      { type: "report", content: "work done" },
    ];

    const runner = new AppstrateContainerRunner({
      adapter: new ScriptedAdapter(script),
      buildPromptContext: async () => ({
        promptContext: basePromptContext(runId),
        timeout: 60,
      }),
    });

    const sink = new AppstrateEventSink({ scope: { orgId: ctx.orgId }, runId });
    const provider = new AppstrateContextProvider({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      packageId: agentId,
      actor,
      excludeRunId: runId,
    });

    const result = await runner.run({
      bundle: baseBundle(),
      context: { runId, input: { topic: "parity" } },
      sink,
      contextProvider: provider,
    });

    // Canonical reducer agreement: the runner's result MUST match what
    // any external runtime consumer would get from reducing the same
    // event stream with reduceEvents (Appstrate has zero freedom here).
    const expectedEvents: AfpsEvent[] = script
      .map(mapRunMessageToAfpsEvent)
      .filter((e): e is AfpsEvent => e !== null);
    const expectedResult = reduceEvents(expectedEvents);
    expect(result).toEqual(expectedResult);

    // Sink aggregates match the result (same data, different shape).
    expect(sink.current.output).toEqual({ deliverable: "shipped" });
    expect(sink.current.state).toEqual({ counter: 7 });
    expect(sink.current.memories).toEqual(["learned A", "learned B"]);
    expect(sink.current.report).toBe("work done");

    // DB side-effect: run_logs received one row per observable event
    // (output + report + log — add_memory / set_state don't log).
    const logs = await db
      .select()
      .from(runLogs)
      .where(and(eq(runLogs.runId, runId), eq(runLogs.orgId, ctx.orgId)))
      .orderBy(asc(runLogs.id));

    const events = logs.map((l) => l.event);
    expect(events).toContain("output");
    expect(events).toContain("report");
    expect(events).toContain("progress");
  });

  it("AppstrateContextProvider feeds buildPromptView with the shape the prelude expects", async () => {
    // Seed a couple of memories so the view is not empty.
    await addPackageMemories(agentId, ctx.orgId, ctx.defaultAppId, ["mem 1", "mem 2"], runId);

    const provider = new AppstrateContextProvider({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      packageId: agentId,
      actor,
      excludeRunId: runId,
    });

    const view = await buildPromptView({
      context: { runId, input: { topic: "parity" }, config: { verbose: true } },
      provider,
    });

    expect(view.runId).toBe(runId);
    expect(view.memories.map((m) => m.content)).toEqual(["mem 2", "mem 1"]);
    expect(view.config).toEqual({ verbose: true });
    expect(view.state).toBeNull();
  });

  it("renderPrompt + @appstrate/environment prelude composes without touching the agent template", async () => {
    const resolver = new AppstratePreludeResolver();
    const providers = [{ id: "gmail", displayName: "Gmail", authMode: "oauth2" }];

    const out = await renderPrompt({
      template: "---\nAgent body: topic={{input.topic}}",
      context: { runId, input: { topic: "parity" } },
      provider: new AppstrateContextProvider({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        packageId: agentId,
        actor,
        excludeRunId: runId,
      }),
      preludes: [{ name: APPSTRATE_ENVIRONMENT_NAME, version: APPSTRATE_ENVIRONMENT_VERSION }],
      preludeResolver: resolver,
      providers,
      timeout: 600,
      platform: buildAppstratePreludeFlags({ providers, timeout: 600 }),
    });

    // Prelude content rendered (environment preamble + providers list).
    expect(out).toContain("Appstrate platform");
    expect(out).toContain("### Connected Providers");
    expect(out).toContain("Gmail");
    expect(out).toContain("You have 600 seconds");

    // Agent body preserved verbatim at the end (after Mustache
    // interpolation of `{{input.topic}}`).
    expect(out).toContain("Agent body: topic=parity");
  });
});
