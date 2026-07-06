// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the credential broker split (credential-split.ts): the
 * pure function that moves KNOWN-SECRET keys off the config drive and into
 * the MMDS payload. A known secret NEVER falls back onto the drive —
 * oversized payloads are the orchestrator's job (raise the VMM store
 * limits, fail-closed beyond the ceiling), not this function's.
 */

import { describe, it, expect } from "bun:test";
import {
  mmdsPayloadBytes,
  splitCredentials,
  MMDS_STORE_LIMIT_BYTES,
  SIDECAR_SECRET_KEYS,
  AGENT_SECRET_KEYS,
} from "../../credential-split.ts";

describe("splitCredentials — secret routing", () => {
  it("moves every known-secret key to MMDS and leaves non-secret keys on the drive", () => {
    const sidecarEnv = {
      RUN_TOKEN: "tok",
      PI_API_KEY: "key",
      PI_LLM_OAUTH_CONFIG_JSON: "{}",
      CONNECT_LOGIN_JSON: "{}",
      INTEGRATIONS_TO_SPAWN_JSON: "[]",
      PROXY_URL: "http://user:pass@proxy.example:8080",
      PLATFORM_API_URL: "http://10.0.0.1:3000", // non-secret
      SIDECAR_PORT: "8080", // non-secret
    };
    const agentEnv = {
      APPSTRATE_SINK_SECRET: "hmac",
      MODEL_API_KEY: "sk-real-provider-key",
      AGENT_PROMPT: "do the thing", // non-secret
      MODEL_ID: "gpt-x", // non-secret
    };

    const split = splitCredentials(sidecarEnv, agentEnv);

    // Secrets are in MMDS.
    for (const key of SIDECAR_SECRET_KEYS) {
      expect(split.mmdsPayload.sidecar_env[key]).toBe(sidecarEnv[key as keyof typeof sidecarEnv]);
    }
    for (const key of AGENT_SECRET_KEYS) {
      expect(split.mmdsPayload.agent_env[key]).toBe(agentEnv[key as keyof typeof agentEnv]);
    }
    // Secrets are NOT on the drive.
    for (const key of SIDECAR_SECRET_KEYS) {
      expect(split.driveSidecarEnv?.[key]).toBeUndefined();
    }
    for (const key of AGENT_SECRET_KEYS) {
      expect(split.driveAgentEnv[key]).toBeUndefined();
    }
    // Non-secret keys stay on the drive, never in MMDS.
    expect(split.driveSidecarEnv?.PLATFORM_API_URL).toBe("http://10.0.0.1:3000");
    expect(split.driveSidecarEnv?.SIDECAR_PORT).toBe("8080");
    expect(split.driveAgentEnv.AGENT_PROMPT).toBe("do the thing");
    expect(split.mmdsPayload.sidecar_env.PLATFORM_API_URL).toBeUndefined();
    expect(split.mmdsPayload.agent_env.AGENT_PROMPT).toBeUndefined();
  });

  it("brokers PROXY_URL (it can embed user:pass credentials) — S-2 regression", () => {
    const split = splitCredentials({ PROXY_URL: "http://u:p@h:1" }, {});
    expect(split.driveSidecarEnv?.PROXY_URL).toBeUndefined();
    expect(split.mmdsPayload.sidecar_env.PROXY_URL).toBe("http://u:p@h:1");
  });

  it("brokers MODEL_API_KEY off the agent drive env (skipSidecar real key) — B-3 regression", () => {
    // skipSidecar/direct-provider runs put the REAL provider key in the
    // agent env; it must never be materialised on the config drive.
    const split = splitCredentials(undefined, { MODEL_API_KEY: "sk-real" });
    expect(split.driveAgentEnv.MODEL_API_KEY).toBeUndefined();
    expect(split.mmdsPayload.agent_env.MODEL_API_KEY).toBe("sk-real");
  });

  it("does not mutate the input maps", () => {
    const sidecarEnv = { RUN_TOKEN: "tok", KEEP: "1" };
    const agentEnv = { APPSTRATE_SINK_SECRET: "hmac" };
    splitCredentials(sidecarEnv, agentEnv);
    expect(sidecarEnv).toEqual({ RUN_TOKEN: "tok", KEEP: "1" });
    expect(agentEnv).toEqual({ APPSTRATE_SINK_SECRET: "hmac" });
  });
});

describe("splitCredentials — empty / skipSidecar", () => {
  it("handles an undefined sidecar env (skipSidecar) without inventing a drive map", () => {
    const split = splitCredentials(undefined, { APPSTRATE_SINK_SECRET: "hmac" });
    expect(split.driveSidecarEnv).toBeUndefined();
    expect(split.mmdsPayload.sidecar_env).toEqual({});
    expect(split.mmdsPayload.agent_env).toEqual({ APPSTRATE_SINK_SECRET: "hmac" });
    expect(split.driveAgentEnv).toEqual({});
  });

  it("handles empty maps — empty payload, empty drive", () => {
    const split = splitCredentials({}, {});
    expect(split.mmdsPayload).toEqual({ sidecar_env: {}, agent_env: {} });
    expect(split.driveSidecarEnv).toEqual({});
    expect(split.driveAgentEnv).toEqual({});
  });
});

describe("splitCredentials — no spill, ever", () => {
  it("keeps an oversized secret in MMDS instead of degrading it to the drive", () => {
    // Larger than Firecracker's default store — the orchestrator raises
    // the VMM limits (or fail-closes); the split NEVER moves the secret
    // back onto the drive.
    const huge = "x".repeat(MMDS_STORE_LIMIT_BYTES + 10_000);
    const split = splitCredentials(
      { INTEGRATIONS_TO_SPAWN_JSON: huge, RUN_TOKEN: "tok", PLATFORM_API_URL: "http://p" },
      {},
    );
    expect(split.driveSidecarEnv?.INTEGRATIONS_TO_SPAWN_JSON).toBeUndefined();
    expect(split.mmdsPayload.sidecar_env.INTEGRATIONS_TO_SPAWN_JSON).toBe(huge);
    expect(split.mmdsPayload.sidecar_env.RUN_TOKEN).toBe("tok");
    expect(split.driveSidecarEnv?.PLATFORM_API_URL).toBe("http://p");
    expect(mmdsPayloadBytes(split.mmdsPayload)).toBeGreaterThan(MMDS_STORE_LIMIT_BYTES);
  });

  it("mmdsPayloadBytes measures the exact serialized PUT body", () => {
    const payload = { sidecar_env: { A: "é" }, agent_env: {} };
    expect(mmdsPayloadBytes(payload)).toBe(Buffer.byteLength(JSON.stringify(payload)));
  });
});
