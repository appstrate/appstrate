// SPDX-License-Identifier: Apache-2.0

import {
  aggregatePerformanceObservations,
  type ObservationValue,
  type ReportObservation,
} from "./chat-engine-performance-report-lib.ts";

const args = Bun.argv.slice(2);
const inputs = option("input")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const output = option("output");
if (inputs.length === 0 || !output) {
  throw new Error(
    "Usage: bun scripts/chat-engine-performance-report.ts --input=dir-a,dir-b --output=summary.json",
  );
}

const observations: ReportObservation[] = [];
for (const input of inputs) {
  const directory = input;
  const glob = new Bun.Glob("*-r*.json");
  for await (const filename of glob.scan({ cwd: directory, onlyFiles: true })) {
    const source = `${directory}/${filename}`;
    const value = (await Bun.file(source).json()) as ObservationValue;
    if (value.schemaVersion !== 1 || value.benchmark == null || value.cell == null) continue;
    observations.push({ source, value });
  }
}
if (observations.length === 0) throw new Error("No benchmark observations found");

const summary = {
  ...aggregatePerformanceObservations(observations),
  generatedAt: new Date().toISOString(),
  command: Bun.argv.join(" "),
  inputDirectories: inputs,
};
await Bun.write(output, `${JSON.stringify(summary, null, 2)}\n`);

function option(name: string): string {
  const prefix = `--${name}=`;
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? "";
}
