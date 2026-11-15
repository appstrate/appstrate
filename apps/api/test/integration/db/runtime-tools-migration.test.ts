// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0053-migrate-runtime-tools.ts` against seeded manifests.
 *
 * Nothing reads `runtime_tools`: an agent receives the run tools by declaring
 * `@appstrate/platform`. The script is the whole mechanism that keeps a stored agent's tools, so
 * the rewrite is asserted on its rows, in both stores, and on every shape it must leave alone.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, packageVersions } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { createTestContext } from "../../helpers/auth.ts";
import {
  exitCode,
  parseArguments,
  parseBefore,
  runMigrateRuntimeTools,
} from "../../../../../scripts/migration/0053-migrate-runtime-tools.ts";

/** `--before`: rows stamped `WRITTEN` predate it, rows left at their default stamp (now) do not. */
const BEFORE = new Date("2026-06-01T00:00:00Z");
const WRITTEN = new Date("2026-01-01T00:00:00Z");
const PLATFORM = "@appstrate/platform";
const DEFAULT_TOOLS = ["recall_memory", "run_history"];
/** The `output` an agent that selected `output` without a schema receives. */
const OPEN_OUTPUT = { schema: { type: "object", properties: {}, additionalProperties: true } };

type Manifest = Record<string, unknown>;

let orgId: string;

function agentManifest(id: string, extra: Manifest): Manifest {
  return { name: id, version: "1.0.0", type: "agent", schema_version: "0.2", ...extra };
}

/** A draft and its published `1.0.0`, both written before `BEFORE` unless `recent`. */
async function seedAgent(id: string, manifest: Manifest, recent = false): Promise<void> {
  const stamp = recent ? {} : { createdAt: WRITTEN, updatedAt: WRITTEN };
  await seedPackage({
    id,
    orgId,
    type: manifest.type as (typeof packages.$inferInsert)["type"],
    draftManifest: manifest,
    ...stamp,
  });
  await seedPackageVersion({
    packageId: id,
    version: "1.0.0",
    manifest,
    ...(recent ? {} : { createdAt: WRITTEN }),
  });
}

async function draftLockOf(id: string): Promise<number> {
  const [row] = await db
    .select({ lock: packages.lockVersion })
    .from(packages)
    .where(eq(packages.id, id));
  return row!.lock;
}

async function storedOf(id: string): Promise<Manifest[]> {
  const [draft] = await db
    .select({ m: packages.draftManifest })
    .from(packages)
    .where(eq(packages.id, id));
  const [version] = await db
    .select({ m: packageVersions.manifest })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, id));
  return [draft!.m as Manifest, version!.m as Manifest];
}

const run = (apply: boolean, lines: string[] = []) =>
  runMigrateRuntimeTools({ apply, before: BEFORE, out: (line) => lines.push(line) });

interface Rewrite {
  name: string;
  extra: Manifest;
  dependencies?: Manifest;
  configuration?: Manifest;
  /** The stored `output`, absent when undefined; `OPEN_OUTPUT` when the rewrite added it. */
  output?: unknown;
}

const REWRITES: Rewrite[] = [
  {
    name: "a selection keeps log and pin, and a declared output schema is the agent's own",
    extra: {
      runtime_tools: ["pin", "output", "log"],
      output: { schema: { type: "object", properties: { n: { type: "number" } } } },
    },
    configuration: { tools: ["log", "pin", ...DEFAULT_TOOLS] },
    output: { schema: { type: "object", properties: { n: { type: "number" } } } },
  },
  {
    name: "an existing @appstrate/platform range is kept",
    extra: {
      runtime_tools: ["note"],
      dependencies: { integrations: { [PLATFORM]: "~1.2.0", "@migr/other": "^2.0.0" } },
    },
    dependencies: { integrations: { [PLATFORM]: "~1.2.0", "@migr/other": "^2.0.0" } },
    configuration: { tools: ["note", ...DEFAULT_TOOLS] },
  },
  {
    name: "existing configuration keys win",
    extra: {
      runtime_tools: ["log"],
      integrations_configuration: { [PLATFORM]: { tools: ["notify"] } },
    },
    configuration: { tools: ["notify"] },
  },
  {
    name: "a runtime_tools that is not an array selects nothing",
    extra: { runtime_tools: "log" },
  },
  { name: "runtime_tools: null selects nothing", extra: { runtime_tools: null } },
  {
    name: "output selected with an empty schema gains the open schema",
    extra: { runtime_tools: ["output"], output: { schema: {} } },
    output: OPEN_OUTPUT,
  },
  {
    name: "output selected with no output gains the open schema",
    extra: { runtime_tools: ["output"] },
    output: OPEN_OUTPUT,
  },
  {
    name: "an output that is not an object is not checked when output is not selected",
    extra: { runtime_tools: ["log"], output: "oops" },
    configuration: { tools: ["log", ...DEFAULT_TOOLS] },
    output: "oops",
  },
  { name: "an agent that never carried runtime_tools declares the integration", extra: {} },
  {
    name: "a range that is not a string declares nothing, and is replaced",
    extra: { dependencies: { integrations: { [PLATFORM]: null } } },
  },
];

/** Each object the rewrite merges into, present but not an object. */
const MALFORMED: [string, Manifest][] = [
  ["dependencies", { dependencies: "oops" }],
  ["dependencies.integrations", { dependencies: { integrations: [] } }],
  ["integrations_configuration", { integrations_configuration: "oops" }],
  ["its platform entry", { integrations_configuration: { [PLATFORM]: "oops" } }],
  ["output, when the rewrite adds its schema", { runtime_tools: ["output"], output: "oops" }],
];

describe("scripts/migration/0053 — runtime_tools moved to @appstrate/platform", () => {
  beforeEach(async () => {
    await truncateAll();
    orgId = (await createTestContext({ orgSlug: "migr" })).org.id;
  });

  it.each(REWRITES)("rewrites both stores: $name", async (c) => {
    const id = "@migr/agent";
    await seedAgent(id, agentManifest(id, c.extra));

    const result = await run(true);
    expect(exitCode(result)).toBe(0);
    for (const counts of [result.draft, result.version]) {
      expect(counts.rewritten).toBe(1);
      expect(counts.outputSchemaAdded).toBe(c.output === OPEN_OUTPUT ? 1 : 0);
      expect(counts.malformed).toEqual([]);
      expect(counts.carryingAfter).toBe(0);
      expect(counts.withoutPlatformAfter).toBe(0);
    }
    for (const m of await storedOf(id)) {
      expect(m).not.toHaveProperty("runtime_tools");
      expect(m.dependencies).toEqual(c.dependencies ?? { integrations: { [PLATFORM]: "^1.0.0" } });
      expect(m.integrations_configuration).toEqual({
        [PLATFORM]: c.configuration ?? { tools: DEFAULT_TOOLS },
      });
      if (c.output !== undefined) expect(m.output).toEqual(c.output);
      else expect(m).not.toHaveProperty("output");
    }
  });

  it("leaves a non-agent manifest, and an agent written after --before without the dependency", async () => {
    const skill = { name: "@migr/skill", version: "1.0.0", type: "skill", runtime_tools: ["log"] };
    await seedAgent("@migr/skill", skill);
    const recent = agentManifest("@migr/recent", {});
    await seedAgent("@migr/recent", recent, true);
    // The bound reaches only the missing-dependency arm: runtime_tools is rewritten whenever written.
    await seedAgent(
      "@migr/recent-tools",
      agentManifest("@migr/recent-tools", { runtime_tools: [] }),
      true,
    );

    const result = await run(true);
    expect(result.draft.rewritten).toBe(1);
    expect(result.version.rewritten).toBe(1);
    expect(await storedOf("@migr/skill")).toEqual([skill, skill]);
    expect(await storedOf("@migr/recent")).toEqual([recent, recent]);
    for (const m of await storedOf("@migr/recent-tools")) {
      expect(m).not.toHaveProperty("runtime_tools");
      expect(m.dependencies).toEqual({ integrations: { [PLATFORM]: "^1.0.0" } });
    }
  });

  it("lists and leaves each malformed path, in both stores", async () => {
    const seeded: Record<string, Manifest> = {};
    for (const [i, [, extra]] of MALFORMED.entries()) {
      const id = `@migr/malformed-${i}`;
      seeded[id] = agentManifest(id, { runtime_tools: ["log"], ...extra });
      await seedAgent(id, seeded[id]!);
    }

    const lines: string[] = [];
    const result = await run(true, lines);
    expect(exitCode(result)).toBe(1);
    const ids = Object.keys(seeded).sort();
    expect(result.version).toMatchObject({
      rewritten: 0,
      malformed: ids.map((id) => `${id}@1.0.0`),
      carryingAfter: MALFORMED.length,
      withoutPlatformAfter: MALFORMED.length,
    });
    expect(result.draft).toMatchObject({
      rewritten: 0,
      malformed: ids.map((id) => `${id} (draft)`),
      carryingAfter: MALFORMED.length,
      withoutPlatformAfter: MALFORMED.length,
    });
    for (const [id, manifest] of Object.entries(seeded)) {
      expect(await storedOf(id)).toEqual([manifest, manifest]);
    }
    expect(lines).toContain("malformed (fix by hand):");
    expect(lines).toContain(`  ${ids[0]} (draft)`);
    expect(lines.some((l) => l.includes("re-run with the same --before"))).toBe(true);
  });

  it("advances the lock version of a rewritten draft only, so a stale editor save is refused", async () => {
    await seedAgent("@migr/agent", agentManifest("@migr/agent", { runtime_tools: ["log"] }));
    await seedAgent("@migr/recent", agentManifest("@migr/recent", {}), true);
    const [agent, recent] = [await draftLockOf("@migr/agent"), await draftLockOf("@migr/recent")];

    await run(false);
    expect(await draftLockOf("@migr/agent")).toBe(agent);
    await run(true);
    expect(await draftLockOf("@migr/agent")).toBe(agent + 1);
    expect(await draftLockOf("@migr/recent")).toBe(recent);
  });

  it("writes nothing on a dry run, and nothing on a second apply", async () => {
    const id = "@migr/agent";
    await seedAgent(id, agentManifest(id, { runtime_tools: ["log"] }));
    const before = await storedOf(id);

    const dry = await run(false);
    expect(dry.draft.rewritten).toBe(1);
    expect(dry.version.rewritten).toBe(1);
    expect(await storedOf(id)).toEqual(before);

    await run(true);
    const again = await run(true);
    expect(again.draft.rewritten).toBe(0);
    expect(again.version.rewritten).toBe(0);
  });
});

describe("scripts/migration/0053 — --before", () => {
  const NOW = Date.parse("2026-11-15T12:00:00Z");

  it.each([
    ["missing", undefined],
    ["garbage", "yesterday"],
    ["a bare number", "1"],
    ["a date alone", "2026-11-15"],
    ["no offset", "2026-11-15T09:30:00"],
    ["no seconds", "2026-11-15T09:30Z"],
    ["an impossible date", "2026-02-30T09:30:00Z"],
    ["hour 24", "2026-11-15T24:00:00Z"],
    ["an offset of 24 hours", "2026-11-15T10:30:00+24:00"],
    ["a future instant", "2026-11-15T12:00:01Z"],
  ])("refuses %s", (_, value) => {
    expect(parseBefore(value, NOW)).toHaveProperty("refusal");
  });

  it.each([
    ["Z", "2026-11-15T09:30:00Z", "2026-11-15T09:30:00.000Z"],
    ["a fraction", "2026-11-15T09:30:00.25Z", "2026-11-15T09:30:00.250Z"],
    ["a positive offset", "2026-11-15T10:30:00+01:00", "2026-11-15T09:30:00.000Z"],
    ["a negative offset", "2026-11-15T04:30:00-05:00", "2026-11-15T09:30:00.000Z"],
    ["now itself", "2026-11-15T12:00:00Z", "2026-11-15T12:00:00.000Z"],
  ])("accepts %s", (_, value, instant) => {
    const parsed = parseBefore(value, NOW);
    expect("before" in parsed && parsed.before.toISOString()).toBe(instant);
  });
});

describe("scripts/migration/0053 — exit code", () => {
  const NOW = Date.parse("2026-11-15T12:00:00Z");
  it.each([
    ["an unknown flag", ["--before", "2026-11-15T09:30:00Z", "--force"]],
    ["no --before", ["--apply"]],
    ["a refused --before", ["--before", "2026-11-15"]],
  ])("2 for %s", (_, args) => {
    const parsed = parseArguments(args, NOW);
    expect("refusal" in parsed && exitCode(parsed)).toBe(2);
  });

  it("reads the arguments it accepts", () => {
    expect(parseArguments(["--before", "2026-11-15T09:30:00Z", "--apply"], NOW)).toEqual({
      apply: true,
      before: new Date("2026-11-15T09:30:00Z"),
    });
  });

  // A completed run: 0 when clean, 1 with a malformed manifest left (asserted on real runs above).
  it("1 for a failure", () => {
    expect(exitCode({ failure: new Error("lock timeout") })).toBe(1);
  });
});
