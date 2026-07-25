// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { purgeStaleAgentProfiles } from "../src/profiles.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

let userData: string;
let partitions: string;
const silent = (): void => {};

async function makeProfile(name: string, ageDays: number): Promise<void> {
  const dir = join(partitions, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "Cookies"), "x");
  const when = new Date(Date.now() - ageDays * DAY_MS);
  await utimes(dir, when, when);
}

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "appstrate-profiles-"));
  partitions = join(userData, "Partitions");
  await mkdir(partitions, { recursive: true });
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("agent profile purge", () => {
  it("removes agent profiles nobody has used in a month", async () => {
    await makeProfile("appstrate-agent-tractr-rq", 45);
    await makeProfile("appstrate-agent-tractr-lespac", 2);

    const purged = await purgeStaleAgentProfiles(userData, silent);

    expect(purged).toEqual(["appstrate-agent-tractr-rq"]);
    expect(await readdir(partitions)).toEqual(["appstrate-agent-tractr-lespac"]);
  });

  it("never touches the user's own browser or webapp profile", async () => {
    // These hold the person's real logins. An idle month means they were
    // on holiday, not that their sessions are disposable.
    await makeProfile("appstrate-browser-default", 400);
    await makeProfile("appstrate-webapp-default", 400);
    await makeProfile("appstrate-agent-tractr-rq", 400);

    const purged = await purgeStaleAgentProfiles(userData, silent);

    expect(purged).toEqual(["appstrate-agent-tractr-rq"]);
    expect((await readdir(partitions)).sort()).toEqual([
      "appstrate-browser-default",
      "appstrate-webapp-default",
    ]);
  });

  it("honours a custom idle window", async () => {
    await makeProfile("appstrate-agent-a", 3);
    expect(await purgeStaleAgentProfiles(userData, silent, 30)).toEqual([]);
    expect(await purgeStaleAgentProfiles(userData, silent, 1)).toEqual(["appstrate-agent-a"]);
  });

  it("is a no-op on a fresh install with no partitions yet", async () => {
    await rm(partitions, { recursive: true, force: true });
    expect(await purgeStaleAgentProfiles(userData, silent)).toEqual([]);
  });
});
