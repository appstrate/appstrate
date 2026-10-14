// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { makeRun } from "../../components/test/run-fixture.tsx";
import { getRunTriggerActor, getRunTriggerType } from "../run-trigger.ts";

const bare = { user_name: null, scheduleId: null, metadata: null };

describe("getRunTriggerType", () => {
  it("names a schedule first, whatever else the run records", () => {
    const run = makeRun({ scheduleId: "sch_1", metadata: { trigger_source: "chat" } });
    expect(getRunTriggerType(run)).toBe("schedule");
  });

  it("reads the recorded launch source, under either of its names", () => {
    expect(getRunTriggerType(makeRun({ ...bare, metadata: { trigger_source: "chat" } }))).toBe(
      "chat",
    );
    expect(getRunTriggerType(makeRun({ ...bare, metadata: { launch_source: "mcp" } }))).toBe("mcp");
  });

  it("tells the CLI, an API key and an end-user apart when no source is recorded", () => {
    expect(getRunTriggerType(makeRun({ ...bare, runner_kind: "cli", apiKeyId: "key_1" }))).toBe(
      "cli",
    );
    expect(getRunTriggerType(makeRun({ ...bare, api_key_name: "CI" }))).toBe("api");
    expect(getRunTriggerType(makeRun({ ...bare, endUserId: "eu_1" }))).toBe("endUser");
  });

  it("falls back to manual rather than guessing from the runner", () => {
    expect(getRunTriggerType(makeRun({ ...bare, runner_kind: "platform" }))).toBe("manual");
    expect(getRunTriggerType(makeRun({ ...bare, metadata: { trigger_source: "other" } }))).toBe(
      "manual",
    );
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
