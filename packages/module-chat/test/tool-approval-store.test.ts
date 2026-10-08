// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's approval mode: on by default, kept per user, and a key of its
 * own, so turning agent authoring off never turns approvals off (or the reverse).
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  bindToolApprovalUser,
  getToolApprovalEnabled,
  setToolApprovalEnabled,
} from "../src/ui/tool-approval-store.ts";
import {
  bindAgentAuthoringUser,
  getAgentAuthoringEnabled,
  setAgentAuthoringEnabled,
} from "../src/ui/agent-authoring-store.ts";

function installStorage(): Map<string, string> {
  const data = new Map<string, string>();
  (
    globalThis as { localStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> }
  ).localStorage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
  return data;
}

afterEach(() => {
  for (const bind of [bindToolApprovalUser, bindAgentAuthoringUser]) bind(null);
  setToolApprovalEnabled(true);
  setAgentAuthoringEnabled(true);
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("tool approval mode", () => {
  it("asks by default", () => {
    installStorage();
    bindToolApprovalUser("u_1");
    expect(getToolApprovalEnabled()).toBe(true);
  });

  it("is kept per user, apart from the agent-authoring switch", () => {
    const data = installStorage();
    bindToolApprovalUser("u_1");
    bindAgentAuthoringUser("u_1");
    setToolApprovalEnabled(false);
    expect(getAgentAuthoringEnabled()).toBe(true);
    expect([...data.keys()]).toEqual(["appstrate.chat.toolApproval:u_1"]);

    bindToolApprovalUser("u_2");
    expect(getToolApprovalEnabled()).toBe(true);
    bindToolApprovalUser("u_1");
    expect(getToolApprovalEnabled()).toBe(false);
  });
});
