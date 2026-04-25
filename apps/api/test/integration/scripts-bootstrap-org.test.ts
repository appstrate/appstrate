// SPDX-License-Identifier: Apache-2.0

// Spawn the bootstrap-org script as a subprocess against the test
// PostgreSQL instance. Verifies the IaC contract: stable JSON output,
// idempotent re-runs, owner-not-found error path.

import { describe, it, expect, beforeEach } from "bun:test";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db, truncateAll } from "../helpers/db.ts";
import { createTestUser } from "../helpers/auth.ts";
import { organizations, organizationMembers } from "@appstrate/db/schema";

const SCRIPT = resolve(import.meta.dir, "../../scripts/bootstrap-org.ts");

interface ScriptResult {
  exitCode: number;
  stdout: Record<string, unknown>;
}

async function runScript(args: string[]): Promise<ScriptResult> {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const exitCode = await proc.exited;
  const stdoutText = await new Response(proc.stdout).text();
  const lastLine = stdoutText.trim().split("\n").pop() ?? "{}";
  return { exitCode, stdout: JSON.parse(lastLine) as Record<string, unknown> };
}

describe("scripts/bootstrap-org.ts", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("creates the org and assigns the user as owner", async () => {
    const owner = await createTestUser({ email: "owner@bootstrap.test" });

    const res = await runScript([
      "--owner=owner@bootstrap.test",
      "--name=Acme HQ",
      "--slug=acme-hq",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout.created).toBe(true);
    expect(res.stdout.slug).toBe("acme-hq");
    expect(res.stdout.ownerEmail).toBe("owner@bootstrap.test");

    const [membership] = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, owner.id));
    expect(membership?.role).toBe("owner");
  });

  it("is idempotent — re-running with an existing owner returns the existing org", async () => {
    await createTestUser({ email: "owner2@bootstrap.test" });

    const first = await runScript(["--owner=owner2@bootstrap.test", "--name=Foo"]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout.created).toBe(true);

    const second = await runScript(["--owner=owner2@bootstrap.test", "--name=Bar"]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout.created).toBe(false);
    expect(second.stdout.reason).toBe("already_owner");
    expect(second.stdout.orgId).toBe(first.stdout.orgId);

    const orgs = await db.select().from(organizations);
    expect(orgs).toHaveLength(1);
  });

  it("exits 2 with owner_not_found when the email is unknown", async () => {
    const res = await runScript(["--owner=ghost@nowhere.test"]);
    expect(res.exitCode).toBe(2);
    expect(res.stdout.error).toBe("owner_not_found");
  });

  it("exits 1 when --owner is missing", async () => {
    const res = await runScript(["--name=No Owner"]);
    expect(res.exitCode).toBe(1);
    expect(res.stdout.error).toBe("missing_owner");
  });
});
