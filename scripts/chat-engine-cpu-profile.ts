// SPDX-License-Identifier: Apache-2.0

/** Extract self-time hot functions from the exact wave of a Bun CPU profile. */

import { summarizeCpuProfileWindow, type CpuProfileInput } from "./chat-engine-performance-lib.ts";

const args = Bun.argv.slice(2);
const profilePath = option("profile");
const observationPath = option("observation");
const outputPath = option("output");
const limit = Number(option("limit", "50"));
if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");

const profile = (await Bun.file(profilePath).json()) as CpuProfileInput;
const observation = (await Bun.file(observationPath).json()) as {
  id: string;
  environment: { commit: string };
  timing: { waveStartedAtEpochMs?: number; waveEndedAtEpochMs?: number };
};
const { waveStartedAtEpochMs, waveEndedAtEpochMs } = observation.timing;
if (waveStartedAtEpochMs === undefined || waveEndedAtEpochMs === undefined) {
  throw new Error("observation does not contain absolute wave timestamps");
}

const summary = summarizeCpuProfileWindow(profile, {
  startEpochMs: waveStartedAtEpochMs,
  endEpochMs: waveEndedAtEpochMs,
});
await Bun.write(
  outputPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      kind: "chat-engine-cpu-wave-profile",
      observationId: observation.id,
      commit: observation.environment.commit,
      window: {
        startEpochMs: waveStartedAtEpochMs,
        endEpochMs: waveEndedAtEpochMs,
        durationMs: waveEndedAtEpochMs - waveStartedAtEpochMs,
      },
      sampledMicros: summary.sampledMicros,
      functions: summary.functions.slice(0, limit),
    },
    null,
    2,
  )}\n`,
);

function option(name: string, fallback?: string): string {
  const prefix = `--${name}=`;
  const value = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
  if (value === undefined || value.length === 0) throw new Error(`missing --${name}=...`);
  return value;
}
