// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for run-context-builder service.
 *
 * Tests ModelNotConfiguredError and signRunToken using the real
 * module graph (no mock.module needed — preload sets up DB/Redis/env).
 */

import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ModelGenerationError } from "@appstrate/core/model-generation";
import {
  buildRunContext,
  ModelNotConfiguredError,
  ModelCredentialMissingError,
  modelCredentialIsPresent,
} from "../../../src/services/run-context-builder.ts";
import { getPackage } from "../../../src/services/package-catalog.ts";
import { logger } from "../../../src/lib/logger.ts";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  seedOrgModel,
  seedOrgModelProviderKey,
  seedPackage,
  seedSpacePackage,
} from "../../helpers/seed.ts";
import { signRunToken, parseSignedToken } from "../../../src/lib/run-token.ts";

// ─── ModelNotConfiguredError ────────────────────────────────

describe("ModelNotConfiguredError", () => {
  it("is an instance of Error", () => {
    const err = new ModelNotConfiguredError();
    expect(err).toBeInstanceOf(Error);
  });

  it("has name set to ModelNotConfiguredError", () => {
    const err = new ModelNotConfiguredError();
    expect(err.name).toBe("ModelNotConfiguredError");
  });

  it("has the expected message", () => {
    const err = new ModelNotConfiguredError();
    expect(err.message).toBe("No LLM model configured for this organization");
  });

  it("produces a stack trace", () => {
    const err = new ModelNotConfiguredError();
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("ModelNotConfiguredError");
  });

  it("can be caught as a generic Error", () => {
    let caught: Error | undefined;
    try {
      throw new ModelNotConfiguredError();
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(ModelNotConfiguredError);
    expect(caught).toBeInstanceOf(Error);
  });
});

// ─── modelCredentialIsPresent ──────────────────────────────

describe("modelCredentialIsPresent", () => {
  it("returns true for a non-empty key", () => {
    expect(modelCredentialIsPresent({ apiKey: "sk-abc123" })).toBe(true);
  });

  it("returns false for an empty-string key (the system-stub hang case)", () => {
    expect(modelCredentialIsPresent({ apiKey: "" })).toBe(false);
  });

  it("returns false for a whitespace-only key", () => {
    expect(modelCredentialIsPresent({ apiKey: "   " })).toBe(false);
    expect(modelCredentialIsPresent({ apiKey: "\t\n" })).toBe(false);
  });

  it("returns true for a key with surrounding whitespace but real content", () => {
    expect(modelCredentialIsPresent({ apiKey: "  sk-real  " })).toBe(true);
  });
});

// ─── ModelCredentialMissingError ───────────────────────────

describe("ModelCredentialMissingError", () => {
  it("is an instance of Error", () => {
    expect(new ModelCredentialMissingError("GPT-5")).toBeInstanceOf(Error);
  });

  it("has name set to ModelCredentialMissingError", () => {
    expect(new ModelCredentialMissingError("GPT-5").name).toBe("ModelCredentialMissingError");
  });

  it("carries the model label and mentions it in the message", () => {
    const err = new ModelCredentialMissingError("Claude Opus");
    expect(err.modelLabel).toBe("Claude Opus");
    expect(err.message).toContain("Claude Opus");
    expect(err.message).toContain("no API key");
  });

  it("is distinguishable from ModelNotConfiguredError via instanceof", () => {
    const err: Error = new ModelCredentialMissingError("X");
    expect(err instanceof ModelCredentialMissingError).toBe(true);
    expect(err instanceof ModelNotConfiguredError).toBe(false);
  });
});

// ─── signRunToken ──────────────────────────────────────

describe("signRunToken", () => {
  it("returns a string with runId and signature", () => {
    const token = signRunToken("run_test-123");
    expect(typeof token).toBe("string");
    expect(token).toContain("run_test-123");
  });

  it("token follows runId.signature format", () => {
    const runId = "run_format-check";
    const token = signRunToken(runId);
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(runId);
    expect(parts[1]!.length).toBe(64); // SHA256 hex = 64 chars
  });

  it("produces deterministic tokens for the same runId", () => {
    const a = signRunToken("run_deterministic");
    const b = signRunToken("run_deterministic");
    expect(a).toBe(b);
  });

  it("produces different tokens for different runIds", () => {
    const a = signRunToken("run_aaa");
    const b = signRunToken("run_bbb");
    expect(a).not.toBe(b);
  });
});

describe("parseSignedToken", () => {
  it("round-trips a valid signed token", () => {
    const runId = "run_roundtrip-test";
    const token = signRunToken(runId);
    expect(parseSignedToken(token)).toBe(runId);
  });

  it("rejects a token with a tampered signature", () => {
    const token = signRunToken("run_tamper");
    const tampered = token.slice(0, -4) + "dead";
    expect(parseSignedToken(tampered)).toBeNull();
  });

  it("rejects a token without a dot separator", () => {
    expect(parseSignedToken("notokenhere")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(parseSignedToken("")).toBeNull();
  });
});

// ─── generation settings reaching the run ──────────────────
//
// Backing: Pi's deepseek-flash, which takes off/low/high/max — no `medium`.

describe("buildRunContext generation settings", () => {
  getTestApp(); // boots the model registry
  let ctx: TestContext;
  const agentId = "@genorg/agent";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "genorg" });
    await seedPackage({
      orgId: ctx.orgId,
      id: agentId,
      type: "agent",
      homeSpaceId: ctx.defaultSpaceId,
      draftManifest: {
        name: agentId,
        version: "0.1.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "Agent",
        description: "Generation settings",
      },
      draftContent: "Do the thing.",
    });
    await seedSpacePackage(ctx.defaultSpaceId, agentId);
  });

  async function flashModel(aliased: boolean): Promise<string> {
    const cred = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      providerId: "deepseek",
      apiShape: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
    });
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: cred.id,
      modelId: "deepseek-flash",
      aliased,
    });
    return model.id;
  }

  async function build(
    modelId: string,
    override: { temperature?: number; reasoning_level?: "medium" | "high" },
    scheduleId?: string,
  ) {
    return buildRunContext({
      runId: `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      agent: (await getPackage(agentId, ctx.orgId))!,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      input: {},
      modelId,
      generationConfig: {},
      generationConfigOverride: override,
      ...(scheduleId ? { scheduleId } : {}),
    });
  }

  it("sends an aliased run the backing's nearest level, and records the requested one", async () => {
    const built = await build(await flashModel(true), { reasoning_level: "medium" });
    expect(built.plan.generationConfig?.reasoning_level).toBe("high");
    // The run row keeps the public level: the clamped one would name the backing's set.
    expect(built.generationConfig.reasoning_level).toBe("medium");
  });

  it("still refuses a level the non-aliased model does not take", async () => {
    await expect(build(await flashModel(false), { reasoning_level: "medium" })).rejects.toThrow(
      ModelGenerationError,
    );
  });

  it("drops a schedule's refused setting for that fire and logs it", async () => {
    const warn = spyOn(logger, "warn");
    try {
      const built = await build(
        await flashModel(false),
        { temperature: 0.3, reasoning_level: "medium" },
        "sched_1",
      );
      expect(built.generationConfig).toEqual({ temperature: 0.3 });
      expect(built.plan.generationConfig).toEqual({ temperature: 0.3 });
      const call = warn.mock.calls.find(([, data]) =>
        JSON.stringify(data ?? {}).includes("sched_1"),
      );
      expect(call?.[1]).toMatchObject({ scheduleId: "sched_1", dropped: ["reasoning_level"] });
      expect(JSON.stringify(call)).not.toContain("medium");
    } finally {
      warn.mockRestore();
    }
  });
});
