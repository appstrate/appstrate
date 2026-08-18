// SPDX-License-Identifier: Apache-2.0

import { $ } from "bun";
import { resolve } from "node:path";
import { publishedObservationName } from "./chat-engine-performance-lib.ts";

const args = Bun.argv.slice(2);
const inputs = option("input")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const output = option("output");
if (inputs.length === 0 || !output) {
  throw new Error(
    "Usage: bun scripts/chat-engine-performance-publish.ts --input=dir-a,dir-b --output=dir",
  );
}

await $`mkdir -p ${output}`.quiet();
const published: Array<{ file: string; sha256: string; source: string }> = [];
for (const input of inputs) {
  const directory = resolve(input);
  const glob = new Bun.Glob("*-r*.json");
  for await (const filename of glob.scan({ cwd: directory, onlyFiles: true })) {
    const source = resolve(directory, filename);
    const contents = await Bun.file(source).text();
    const observation = JSON.parse(contents) as { schemaVersion?: unknown; kind?: unknown };
    if (
      observation.schemaVersion !== 1 ||
      observation.kind !== "chat-engine-performance-observation"
    ) {
      continue;
    }
    const publishedName = publishedObservationName(input, filename);
    await Bun.write(`${output}/${publishedName}`, contents);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(contents);
    published.push({
      file: publishedName,
      sha256: hasher.digest("hex"),
      source: `${input}/${filename}`,
    });
  }
}

published.sort((left, right) => left.file.localeCompare(right.file));
await Bun.write(
  `${output}/index.v1.json`,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      kind: "chat-engine-performance-raw-index",
      generatedAt: new Date().toISOString(),
      observations: published,
    },
    null,
    2,
  )}\n`,
);

function option(name: string): string {
  const prefix = `--${name}=`;
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? "";
}
