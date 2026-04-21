// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/index.ts";
import { captureIo, writeBundleFile, writeJsonFile } from "./helpers.ts";

describe("afps run", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "afps-cli-run-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("replays scripted events through the ConsoleSink", async () => {
    const bundle = join(dir, "a.afps");
    const events = join(dir, "events.json");
    await writeBundleFile(bundle);
    await writeJsonFile(events, [
      { type: "log", level: "info", message: "start" },
      { type: "add_memory", content: "seen" },
      { type: "output", data: { ok: true } },
    ]);
    const io = captureIo();
    const code = await runCli(["run", bundle, "--events", events], io);
    expect(code).toBe(0);
    const text = io.stdoutText();
    expect(text).toContain("start");
    expect(text).toContain("seen");
    expect(text).toContain("run complete");
  });

  it("writes the RunResult to --output", async () => {
    const bundle = join(dir, "a.afps");
    const events = join(dir, "events.json");
    const output = join(dir, "result.json");
    await writeBundleFile(bundle);
    await writeJsonFile(events, [
      { type: "add_memory", content: "m1" },
      { type: "set_state", state: { done: true } },
    ]);
    const code = await runCli(
      ["run", bundle, "--events", events, "--output", output, "--quiet"],
      captureIo(),
    );
    expect(code).toBe(0);
    const result = JSON.parse(await readFile(output, "utf-8"));
    expect(result.memories).toEqual([{ content: "m1" }]);
    expect(result.state).toEqual({ done: true });
  });

  it("persists a JSONL stream when --sink=file", async () => {
    const bundle = join(dir, "a.afps");
    const events = join(dir, "events.json");
    const sinkFile = join(dir, "stream.jsonl");
    await writeBundleFile(bundle);
    await writeJsonFile(events, [
      { type: "add_memory", content: "one" },
      { type: "add_memory", content: "two" },
    ]);
    const code = await runCli(
      ["run", bundle, "--events", events, "--sink", "file", "--sink-file", sinkFile],
      captureIo(),
    );
    expect(code).toBe(0);
    const body = await readFile(sinkFile, "utf-8");
    const lines = body.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    const second = JSON.parse(lines[1]!);
    expect(first.type).toBe("memory.added");
    expect(first.content).toBe("one");
    expect(second.type).toBe("memory.added");
    expect(second.content).toBe("two");
  });

  it("returns exit 1 on an invalid scripted event", async () => {
    const bundle = join(dir, "a.afps");
    const events = join(dir, "events.json");
    await writeBundleFile(bundle);
    await writeJsonFile(events, [{ type: "unknown", weird: true }]);
    const io = captureIo();
    const code = await runCli(["run", bundle, "--events", events], io);
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("invalid event at index 0");
  });

  it("returns exit 2 when --events is missing", async () => {
    const bundle = join(dir, "a.afps");
    await writeBundleFile(bundle);
    const io = captureIo();
    const code = await runCli(["run", bundle], io);
    expect(code).toBe(2);
    expect(io.stderrText()).toContain("--events");
  });

  it("rejects an unknown --sink mode with exit 1", async () => {
    const bundle = join(dir, "a.afps");
    const events = join(dir, "events.json");
    await writeBundleFile(bundle);
    await writeJsonFile(events, []);
    const io = captureIo();
    const code = await runCli(["run", bundle, "--events", events, "--sink", "slack"], io);
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("unknown --sink");
  });
});
