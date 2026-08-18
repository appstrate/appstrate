// SPDX-License-Identifier: Apache-2.0

import { $ } from "bun";

interface Snapshot {
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

const args = Bun.argv.slice(2);
if (args.includes("--worker")) {
  await runWorker();
} else {
  await runController();
}

async function runController(): Promise<void> {
  const repetitions = numberOption("repetitions", 10);
  const outputDir = option("output") || "artifacts/chat-engine-performance/fixed-load";
  const summaryOutput = option("summary-output");
  await $`mkdir -p ${outputDir}`.quiet();
  const observations: string[] = [];
  const values: Array<{
    importDurationMs: number;
    delta: Snapshot;
  }> = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const outputFile = `${outputDir}/pi-fixed-load-r${repetition}.json`;
    const worker = Bun.spawn([process.execPath, import.meta.path, "--worker"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CHAT_PERF_OUTPUT_FILE: outputFile,
        CHAT_PERF_REPETITION: `${repetition}`,
        BETTER_AUTH_SECRET: "performance-test-secret-at-least-32-characters",
        UPLOAD_SIGNING_SECRET: "performance-upload-secret-at-least-16",
        RUN_TOKEN_SECRET: "performance-run-secret-at-least-16",
        CONNECT_SESSION_SECRET: "performance-connect-secret-at-least-16",
        CONNECTION_ENCRYPTION_KEY: btoa("0123456789abcdef0123456789abcdef"),
      },
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await worker.exited) !== 0) throw new Error(`Fixed-load worker ${repetition} failed`);
    observations.push(outputFile);
    values.push(await Bun.file(outputFile).json());
  }
  const manifest = {
    schemaVersion: 1,
    kind: "chat-pi-fixed-load-manifest",
    commit: textCommand(["git", "rev-parse", "HEAD"]),
    bunVersion: Bun.version,
    command: Bun.argv.join(" "),
    repetitions,
    observations,
    summary: {
      importDurationMs: summarize(values.map((value) => value.importDurationMs)),
      delta: {
        rss: summarize(values.map((value) => value.delta.rss)),
        heapUsed: summarize(values.map((value) => value.delta.heapUsed)),
        external: summarize(values.map((value) => value.delta.external)),
        arrayBuffers: summarize(values.map((value) => value.delta.arrayBuffers)),
      },
    },
  };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  await Bun.write(`${outputDir}/manifest.json`, serialized);
  if (summaryOutput) await Bun.write(summaryOutput, serialized);
}

async function runWorker(): Promise<void> {
  const outputFile = requiredEnv("CHAT_PERF_OUTPUT_FILE");
  const repetition = Number(requiredEnv("CHAT_PERF_REPETITION"));
  await import("../packages/module-chat/node_modules/ai");
  Bun.gc(true);
  await Bun.sleep(100);
  const before = snapshot();
  const startedAt = performance.now();
  await import("../packages/module-chat/src/pi-chat/engine.ts");
  const importDurationMs = performance.now() - startedAt;
  Bun.gc(true);
  await Bun.sleep(100);
  const after = snapshot();
  await Bun.write(
    outputFile,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: "chat-pi-fixed-load-observation",
        repetition,
        baseline: "ai-sdk-package-loaded",
        loaded: "packages/module-chat/src/pi-chat/engine.ts",
        importDurationMs,
        before,
        after,
        delta: {
          rss: after.rss - before.rss,
          heapUsed: after.heapUsed - before.heapUsed,
          external: after.external - before.external,
          arrayBuffers: after.arrayBuffers - before.arrayBuffers,
        },
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

function snapshot(): Snapshot {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

function summarize(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!,
    min: sorted[0]!,
    max: sorted.at(-1)!,
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function option(name: string): string {
  const prefix = `--${name}=`;
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function numberOption(name: string, fallback: number): number {
  const value = Number(option(name) || fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function textCommand(command: string[]): string {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "unknown";
}
