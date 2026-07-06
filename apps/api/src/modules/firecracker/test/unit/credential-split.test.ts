// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the credential broker split (credential-split.ts): the
 * pure function that moves KNOWN-SECRET keys off the config drive and into
 * the MMDS payload, enforcing the MMDS store budget by spilling the largest
 * offending secrets back to the drive when the payload would overflow.
 */

import { describe, it, expect } from "bun:test";
import {
  splitCredentials,
  MMDS_PAYLOAD_BUDGET_BYTES,
  SIDECAR_SECRET_KEYS,
  AGENT_SECRET_KEYS,
} from "../../credential-split.ts";

describe("splitCredentials — all secrets fit", () => {
  it("moves every known-secret key to MMDS and leaves non-secret keys on the drive", () => {
    const sidecarEnv = {
      RUN_TOKEN: "tok",
      PI_API_KEY: "key",
      PI_LLM_OAUTH_CONFIG_JSON: "{}",
      CONNECT_LOGIN_JSON: "{}",
      INTEGRATIONS_TO_SPAWN_JSON: "[]",
      PLATFORM_API_URL: "http://10.0.0.1:3000", // non-secret
      SIDECAR_PORT: "8080", // non-secret
    };
    const agentEnv = {
      APPSTRATE_SINK_SECRET: "hmac",
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
    expect(split.driveAgentEnv.APPSTRATE_SINK_SECRET).toBeUndefined();
    // Non-secret keys stay on the drive, never in MMDS.
    expect(split.driveSidecarEnv?.PLATFORM_API_URL).toBe("http://10.0.0.1:3000");
    expect(split.driveSidecarEnv?.SIDECAR_PORT).toBe("8080");
    expect(split.driveAgentEnv.AGENT_PROMPT).toBe("do the thing");
    expect(split.mmdsPayload.sidecar_env.PLATFORM_API_URL).toBeUndefined();
    expect(split.mmdsPayload.agent_env.AGENT_PROMPT).toBeUndefined();
    expect(split.spilledKeys).toEqual([]);
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

  it("handles empty maps — empty payload, empty drive, no spill", () => {
    const split = splitCredentials({}, {});
    expect(split.mmdsPayload).toEqual({ sidecar_env: {}, agent_env: {} });
    expect(split.driveSidecarEnv).toEqual({});
    expect(split.driveAgentEnv).toEqual({});
    expect(split.spilledKeys).toEqual([]);
  });
});

describe("splitCredentials — oversized payload spills largest-first", () => {
  it("spills the largest offending secret back onto the drive until it fits", () => {
    // INTEGRATIONS_TO_SPAWN_JSON alone exceeds the budget — it must spill,
    // the smaller secrets stay in MMDS.
    const huge = "x".repeat(MMDS_PAYLOAD_BUDGET_BYTES + 1_000);
    const sidecarEnv = {
      RUN_TOKEN: "tok",
      INTEGRATIONS_TO_SPAWN_JSON: huge,
      PLATFORM_API_URL: "http://10.0.0.1:3000",
    };
    const split = splitCredentials(sidecarEnv, {});

    // The oversized key spilled back to the drive; its name is reported.
    expect(split.spilledKeys).toContain("INTEGRATIONS_TO_SPAWN_JSON");
    expect(split.driveSidecarEnv?.INTEGRATIONS_TO_SPAWN_JSON).toBe(huge);
    expect(split.mmdsPayload.sidecar_env.INTEGRATIONS_TO_SPAWN_JSON).toBeUndefined();
    // Smaller secret still brokered.
    expect(split.mmdsPayload.sidecar_env.RUN_TOKEN).toBe("tok");
    // Non-secret untouched.
    expect(split.driveSidecarEnv?.PLATFORM_API_URL).toBe("http://10.0.0.1:3000");
    // Resulting payload is within budget.
    expect(Buffer.byteLength(JSON.stringify(split.mmdsPayload))).toBeLessThanOrEqual(
      MMDS_PAYLOAD_BUDGET_BYTES,
    );
  });

  it("spills the biggest key first, keeping the most secrets in MMDS", () => {
    // Two keys each ~60% of budget: exactly one must spill (the larger),
    // and the smaller must remain brokered.
    const big = "b".repeat(Math.floor(MMDS_PAYLOAD_BUDGET_BYTES * 0.6));
    const bigger = "a".repeat(Math.floor(MMDS_PAYLOAD_BUDGET_BYTES * 0.65));
    const sidecarEnv = {
      PI_API_KEY: big,
      INTEGRATIONS_TO_SPAWN_JSON: bigger,
      RUN_TOKEN: "tok",
    };
    const split = splitCredentials(sidecarEnv, {});
    // The larger key spilled; the smaller two remain in MMDS.
    expect(split.spilledKeys).toEqual(["INTEGRATIONS_TO_SPAWN_JSON"]);
    expect(split.mmdsPayload.sidecar_env.PI_API_KEY).toBe(big);
    expect(split.mmdsPayload.sidecar_env.RUN_TOKEN).toBe("tok");
    expect(split.driveSidecarEnv?.INTEGRATIONS_TO_SPAWN_JSON).toBe(bigger);
    expect(Buffer.byteLength(JSON.stringify(split.mmdsPayload))).toBeLessThanOrEqual(
      MMDS_PAYLOAD_BUDGET_BYTES,
    );
  });
});
