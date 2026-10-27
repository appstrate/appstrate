// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { makeRun } from "../../test/run-fixture.ts";
import { getRunTriggerActor, getRunTriggerType } from "../run-trigger.ts";

const bare = { user_name: null, scheduleId: null, metadata: null };

describe("getRunTriggerType", () => {
  it("names a schedule first, whatever else the run records", () => {
    const run = makeRun({ scheduleId: "sch_1", api_key_name: "CI", runner_kind: "cli" });
    expect(getRunTriggerType(run)).toBe("schedule");
  });

  it("tells the CLI, an API key and an end-user apart", () => {
    expect(getRunTriggerType(makeRun({ ...bare, runner_kind: "cli", apiKeyId: "key_1" }))).toBe(
      "cli",
    );
    expect(getRunTriggerType(makeRun({ ...bare, api_key_name: "CI" }))).toBe("api");
    expect(getRunTriggerType(makeRun({ ...bare, endUserId: "eu_1" }))).toBe("endUser");
  });

  it("falls back to manual rather than guessing from the runner", () => {
    expect(getRunTriggerType(makeRun({ ...bare, runner_kind: "platform" }))).toBe("manual");
  });
});

describe("getRunTriggerActor", () => {
  it("names the end-user, else the member, else the API key", () => {
    const all = { end_user_name: "Eve", user_name: "Alice", api_key_name: "CI" };
    expect(getRunTriggerActor(makeRun(all))).toBe("Eve");
    expect(getRunTriggerActor(makeRun({ ...all, end_user_name: null }))).toBe("Alice");
    expect(getRunTriggerActor(makeRun({ api_key_name: "CI", user_name: null }))).toBe("CI");
    expect(getRunTriggerActor(makeRun({ user_name: null }))).toBeNull();
  });
});
