// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/index.ts";
import { captureIo, writeBundleFile, writeJsonFile } from "./helpers.ts";
import { generateKeyPair } from "../../src/bundle/signing.ts";

describe("afps inspect", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "afps-cli-inspect-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("prints a human-readable summary", async () => {
    const path = join(dir, "agent.afps");
    await writeBundleFile(path);
    const io = captureIo();
    const code = await runCli(["inspect", path], io);
    expect(code).toBe(0);
    const text = io.stdoutText();
    expect(text).toContain("name:          @acme/hello");
    expect(text).toContain("schemaVersion: 1.1");
    expect(text).toContain("signature:     <none>");
    expect(text).toContain("Prompt");
  });

  it("emits a single JSON report under --json", async () => {
    const path = join(dir, "agent.afps");
    await writeBundleFile(path);
    const io = captureIo();
    const code = await runCli(["inspect", path, "--json"], io);
    expect(code).toBe(0);
    const report = JSON.parse(io.stdoutText());
    expect(report.manifest.name).toBe("@acme/hello");
    expect(report.root).toBe("@acme/hello@1.0.0");
    expect(report.packages).toHaveLength(1);
    expect(report.packages[0].identity).toBe("@acme/hello@1.0.0");
    expect(report.packages[0].files).toEqual(
      expect.arrayContaining(["manifest.json", "prompt.md"]),
    );
    expect(report.signature).toBeNull();
    expect(report.promptBytes).toBeGreaterThan(0);
  });

  it("surfaces a signature summary after signing", async () => {
    const path = join(dir, "agent.afps");
    const keyPath = join(dir, "key.json");
    await writeBundleFile(path);
    const kp = generateKeyPair();
    await writeJsonFile(keyPath, kp);
    await runCli(["sign", path, "--key", keyPath], captureIo());

    const io = captureIo();
    const code = await runCli(["inspect", path, "--json"], io);
    expect(code).toBe(0);
    const report = JSON.parse(io.stdoutText());
    expect(report.signature).toEqual({
      alg: "ed25519",
      keyId: kp.keyId,
      chainLength: 0,
    });
  });
});

describe("afps render", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "afps-cli-render-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("renders the template against the provided context + snapshot", async () => {
    const path = join(dir, "agent.afps");
    const ctxPath = join(dir, "ctx.json");
    const snapPath = join(dir, "snap.json");
    await writeBundleFile(path, {
      prompt: [
        "Run {{runId}}: {{input.topic}}",
        "{{#memories}}- {{content}}\n{{/memories}}",
        "{{^memories}}(empty){{/memories}}",
      ].join("\n"),
    });
    await writeJsonFile(ctxPath, { runId: "run_1", input: { topic: "birds" } });
    await writeJsonFile(snapPath, {
      memories: [
        { content: "Birds are warm-blooded.", createdAt: 1 },
        { content: "Most fly.", createdAt: 2 },
      ],
    });

    const io = captureIo();
    const code = await runCli(["render", path, "--context", ctxPath, "--snapshot", snapPath], io);
    expect(code).toBe(0);
    const out = io.stdoutText();
    expect(out).toContain("Run run_1: birds");
    expect(out).toContain("- Birds are warm-blooded.");
    expect(out).toContain("- Most fly.");
    expect(out).not.toContain("(empty)");
  });

  it("falls through the inverted section with no snapshot", async () => {
    const path = join(dir, "agent.afps");
    await writeBundleFile(path, {
      prompt: "{{#memories}}m{{/memories}}{{^memories}}none{{/memories}}",
    });
    const io = captureIo();
    const code = await runCli(["render", path], io);
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("none");
  });

  it("uses a default runId when the context omits it", async () => {
    const path = join(dir, "agent.afps");
    await writeBundleFile(path, { prompt: "run={{runId}}" });
    const io = captureIo();
    const code = await runCli(["render", path], io);
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("run=cli-dry-run");
  });
});
