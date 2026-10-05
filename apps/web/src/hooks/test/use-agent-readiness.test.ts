// SPDX-License-Identifier: Apache-2.0

/**
 * The model half of the run-button gate. `resolvesToUsableModel` has to mirror
 * the server cascade in `resolveModel` (agent pin → org default): a green Run
 * button that ends in an inference error, or a greyed one for a run the server
 * would have happily resolved, are both wrong.
 */

import { describe, it, expect } from "bun:test";
import type { AgentDetail } from "@appstrate/shared-types";
import {
  agentLaunchRefusal,
  agentModelBlocker,
  agentRunBlocker,
  resolvesToUsableModel,
} from "../use-agent-readiness";
import { isModelPinUnavailable } from "../../lib/model-selectability";
import type { OrgModelInfo } from "../use-models";

function model(over: Partial<OrgModelInfo>): OrgModelInfo {
  return {
    id: "m1",
    label: "Claude",
    apiShape: "anthropic-messages",
    providerId: "anthropic",
    provider_name: "Anthropic",
    pi_provider: "anthropic",
    base_url: "https://api.anthropic.com",
    modelId: "claude-sonnet-4",
    enabled: true,
    is_default: false,
    needs_reconnection: false,
    aliased: false,
    iconUrl: null,
    source: "custom",
    credentialId: "c1",
    created_by: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
    generation: over.generation ?? null,
  };
}

const DEFAULT_OK = model({ id: "m_default", is_default: true });

describe("resolvesToUsableModel", () => {
  it("accepts a usable pin", () => {
    expect(resolvesToUsableModel([model({ id: "m_pin" })], "m_pin")).toBe(true);
  });

  it("accepts a usable org default with no pin", () => {
    expect(resolvesToUsableModel([DEFAULT_OK], null)).toBe(true);
  });

  it("falls back to the org default when the pin is dead", () => {
    // `resolveModel` step 1 returns null for a dead pin and drops to step 2.
    const pin = model({ id: "m_pin", needs_reconnection: true });
    expect(resolvesToUsableModel([pin, DEFAULT_OK], "m_pin")).toBe(true);
  });

  it("falls back to the org default when the pin is not listed at all", () => {
    expect(resolvesToUsableModel([DEFAULT_OK], "m_deleted")).toBe(true);
  });

  it("rejects a dead pin with a dead default — nothing left to resolve", () => {
    const pin = model({ id: "m_pin", needs_reconnection: true });
    const dead = model({ id: "m_default", is_default: true, needs_reconnection: true });
    expect(resolvesToUsableModel([pin, dead], "m_pin")).toBe(false);
  });

  it("rejects a disabled org default", () => {
    expect(resolvesToUsableModel([model({ is_default: true, enabled: false })], null)).toBe(false);
  });

  it("rejects a catalog with no default at all", () => {
    expect(resolvesToUsableModel([model({ id: "m_other" })], null)).toBe(false);
  });

  it("rejects an empty catalog", () => {
    expect(resolvesToUsableModel([], "m_pin")).toBe(false);
  });
});

/** A launchable agent as a full read (`agents:read`) sees it. */
function agent(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    id: "@acme/worker",
    source: "local",
    dependencies: { skills: [], mcp_servers: [], integrations: [] },
    input: { schema: { type: "object", properties: {} }, values: {}, locked_fields: [] },
    running_runs: 0,
    last_run: null,
    prompt: "Do the thing.",
    manifest: { name: "@acme/worker" },
    scope: "@acme",
    version: "1.0.0",
    definition: "published",
    home_space_id: "spc_1",
    home_writable: false,
    home_deletable: false,
    home_shareable: false,
    effective_timeout_seconds: 300,
    active: true,
    ...over,
  };
}

describe("agentRunBlocker", () => {
  it("lets a ready agent run", () => {
    expect(agentRunBlocker(agent(), [DEFAULT_OK], null)).toBeNull();
  });

  it("does not call a prompt empty when the read withholds it", () => {
    // `agents:run` without `agents:read`: the summary carries no prompt, no manifest.
    const summary = agent({ prompt: undefined, manifest: undefined });
    expect(agentRunBlocker(summary, [DEFAULT_OK], null)).toBeNull();
  });

  it("blocks an empty prompt the caller can read", () => {
    expect(agentRunBlocker(agent({ prompt: "  " }), [DEFAULT_OK], null)).toBe(
      "detail.titleEmptyPrompt",
    );
  });

  it("blocks a never-published agent for a reader who cannot run its draft", () => {
    const unpublished = agent({ definition: "draft", home_writable: false });
    expect(agentRunBlocker(unpublished, [DEFAULT_OK], null)).toBe("detail.titleNeverPublished");
    expect(agentRunBlocker({ ...unpublished, active: false }, [DEFAULT_OK], null)).toBe(
      "detail.titleNotActive",
    );
  });

  it("keeps the model verdict readable behind an earlier blocker", () => {
    // The buttons say "empty prompt"; the page alert still has to say "no model".
    expect(agentRunBlocker(agent({ prompt: "" }), [], null)).toBe("detail.titleEmptyPrompt");
    expect(agentModelBlocker([], null)).toBe("detail.titleModel");
    expect(agentModelBlocker([DEFAULT_OK], null)).toBeNull();
  });

  it("names the activation first, as the run gate does", () => {
    expect(agentRunBlocker(agent({ active: false, prompt: "" }), [], null)).toBe(
      "detail.titleNotActive",
    );
  });

  it("tells a missing default from no model at all", () => {
    expect(agentRunBlocker(agent(), [], null)).toBe("detail.titleModel");
    expect(agentRunBlocker(agent(), [model({ id: "m_other" })], null)).toBe(
      "detail.titleNoDefaultModel",
    );
  });

  it("stays optimistic while the model catalog loads", () => {
    expect(agentRunBlocker(agent(), undefined, null)).toBeNull();
  });
});

describe('agentLaunchRefusal — the gate of "run with options"', () => {
  it("refuses what no option cures, activation first", () => {
    const unpublished = agent({ definition: "draft", home_writable: false });
    expect(agentLaunchRefusal(agent({ active: false }))).toBe("detail.titleNotActive");
    expect(agentLaunchRefusal(unpublished)).toBe("detail.titleNeverPublished");
    expect(agentLaunchRefusal({ ...unpublished, active: false })).toBe("detail.titleNotActive");
  });

  it("stays open for what the options modal can still change", () => {
    // No usable default (a model override cures it) and an empty draft prompt
    // (another version may not be): a plain run is blocked, this launch is not.
    const curable = agent({ prompt: "" });
    expect(agentRunBlocker(curable, [], null)).toBe("detail.titleEmptyPrompt");
    expect(agentRunBlocker(agent(), [model({ id: "m_other" })], null)).toBe(
      "detail.titleNoDefaultModel",
    );
    expect(agentLaunchRefusal(curable)).toBeNull();
    expect(agentLaunchRefusal(agent())).toBeNull();
  });
});

describe("isModelPinUnavailable", () => {
  it("is false without a pin, and for a pin that can serve", () => {
    expect(isModelPinUnavailable([DEFAULT_OK], null)).toBe(false);
    expect(isModelPinUnavailable([model({ id: "m_pin" })], "m_pin")).toBe(false);
  });

  it("is true for a pin that is gone, switched off, or on a dead credential", () => {
    expect(isModelPinUnavailable([DEFAULT_OK], "m_deleted")).toBe(true);
    expect(isModelPinUnavailable([model({ id: "m_pin", enabled: false })], "m_pin")).toBe(true);
    expect(isModelPinUnavailable([model({ id: "m_pin", needs_reconnection: true })], "m_pin")).toBe(
      true,
    );
  });
});
