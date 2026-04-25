// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/index.ts";
import { captureIo } from "./helpers.ts";

describe("afps keygen", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "afps-cli-keygen-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("prints a JSON key pair to stdout when --out is absent", async () => {
    const io = captureIo();
    const code = await runCli(["keygen"], io);
    expect(code).toBe(0);
    const out = JSON.parse(io.stdoutText());
    expect(Buffer.from(out.publicKey, "base64").length).toBe(32);
    expect(Buffer.from(out.privateKey, "base64").length).toBe(32);
    expect(out.keyId).toMatch(/^[a-f0-9]{16}$/);
  });

  it("writes to --out with mode 0600 and prints the path", async () => {
    const path = join(dir, "key.json");
    const io = captureIo();
    const code = await runCli(["keygen", "--out", path], io);
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain(path);
    const contents = JSON.parse(await readFile(path, "utf-8"));
    expect(contents.keyId).toMatch(/^[a-f0-9]{16}$/);
    const info = await stat(path);
    // mask out file-type bits, check permission bits only
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("honors --key-id override", async () => {
    const io = captureIo();
    const code = await runCli(["keygen", "--key-id", "my-root-2026"], io);
    expect(code).toBe(0);
    const out = JSON.parse(io.stdoutText());
    expect(out.keyId).toBe("my-root-2026");
  });

  it("reports an error on unknown flags", async () => {
    const io = captureIo();
    const code = await runCli(["keygen", "--nope"], io);
    expect(code).toBe(2);
    expect(io.stderrText()).toContain("afps keygen");
  });
});
