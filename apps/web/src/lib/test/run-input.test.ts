// SPDX-License-Identifier: Apache-2.0

/**
 * A requested run opens the input form only where a click on the agent's Run
 * button would have: never past a
 * disabled button, a caller without `agents:run`, a never-published agent, or
 * an agent that declares no input (a click launches those directly).
 *
 * The form is a `<Modal>`, which renders nothing without a DOM, so the verdict
 * is pinned on the predicate the button reads.
 */

import { describe, expect, it } from "bun:test";
import type { AgentDetail } from "@appstrate/shared-types";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { runInputOpens } = await import("../run-input.ts");

function agent(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    definition: "published",
    home_writable: false,
    input: {
      schema: { type: "object", properties: { topic: { type: "string" } } },
      values: {},
      locked_fields: [],
    },
    ...over,
  } as unknown as AgentDetail;
}

const open = { requested: true, disabled: false, canRun: true, detail: agent() };

describe("the run input form", () => {
  it("opens where the button would open it", () => {
    expect(runInputOpens(open)).toBe(true);
  });

  it("stays closed when the address names another agent", () => {
    expect(runInputOpens({ ...open, requested: false })).toBe(false);
  });

  it("stays closed behind a disabled button", () => {
    expect(runInputOpens({ ...open, disabled: true })).toBe(false);
  });

  it("stays closed for a caller who may not run the agent", () => {
    expect(runInputOpens({ ...open, canRun: false })).toBe(false);
  });

  it("stays closed until the agent detail has landed", () => {
    expect(runInputOpens({ ...open, detail: undefined })).toBe(false);
  });

  it("stays closed on a draft the reader cannot run", () => {
    expect(runInputOpens({ ...open, detail: agent({ definition: "draft" }) })).toBe(false);
  });

  it("stays closed on an agent that declares no input", () => {
    const noInput = agent({
      input: { schema: { type: "object", properties: {} }, values: {}, locked_fields: [] },
    });
    expect(runInputOpens({ ...open, detail: noInput })).toBe(false);
  });
});
