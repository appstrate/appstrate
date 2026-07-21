// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the agent-output ingestion route (Phase 2):
 * `POST /api/runs/:runId/documents`.
 *
 * Covers the streaming happy path (durable row + org counter + sha256), the
 * synchronous enforcement gates (per-file 413 with partial-object cleanup,
 * per-run output 413, org quota 403), the sweep-retry dedup (200 on identical
 * sha256+name), the running-status gate (409), unknown run (404), and the auth
 * contract: the run HMAC signature authenticates, a cookie/API-key does not,
 * and a wrong-run signature is rejected.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs, documents, organizations } from "@appstrate/db/schema";
import { encrypt } from "@appstrate/connect";
import { sign } from "@appstrate/afps-runtime/events";
import { _resetCacheForTesting } from "@appstrate/env";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";

const app = getTestApp();

const RUN_SECRET = "a".repeat(43); // matches mintSinkCredentials base64url(32 bytes)

/** Standard Webhooks HMAC over an EMPTY body (how the runtime signs this POST). */
function signedEmptyBody(secret: string): Record<string, string> {
  const msgId = `msg_${crypto.randomUUID()}`;
  const timestampSec = Math.floor(Date.now() / 1000);
  return { ...sign({ msgId, timestampSec, body: "", secret }) };
}

function docHeaders(secret: string, name: string, mime = "text/plain"): Record<string, string> {
  return { ...signedEmptyBody(secret), "X-Document-Name": name, "Content-Type": mime };
}

async function withEnv(key: string, value: string, fn: () => Promise<void>): Promise<void> {
  const prev = process.env[key];
  process.env[key] = value;
  _resetCacheForTesting();
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
    _resetCacheForTesting();
  }
}

async function seedRun(
  ctx: TestContext,
  overrides: { status?: "pending" | "running" | "success"; secret?: string } = {},
): Promise<string> {
  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(runs).values({
    id: runId,
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    status: overrides.status ?? "running",
    runOrigin: "platform",
    sinkSecretEncrypted: encrypt(overrides.secret ?? RUN_SECRET),
    sinkExpiresAt: new Date(Date.now() + 3600_000),
    startedAt: new Date(),
  });
  return runId;
}

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function orgBytesUsed(orgId: string): Promise<number> {
  const [org] = await db
    .select({ used: organizations.documentsBytesUsed })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return org!.used;
}

function postDoc(runId: string, headers: Record<string, string>, body: Uint8Array | string) {
  return app.request(`/api/runs/${runId}/documents`, { method: "POST", headers, body });
}

describe("POST /api/runs/:runId/documents — agent-output ingestion", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "docpub" });
  });

  it("stores a durable document: 201, row, org counter, sha256", async () => {
    const runId = await seedRun(ctx);
    const bytes = new TextEncoder().encode("<html>report</html>");
    const res = await postDoc(runId, docHeaders(RUN_SECRET, "report.html", "text/html"), bytes);

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      uri: string;
      name: string;
      mime: string;
      size: number;
      sha256: string;
    };
    expect(body.id).toMatch(/^doc_/);
    expect(body.uri).toBe(`document://${body.id}`);
    expect(body.name).toBe("report.html");
    expect(body.mime).toBe("text/html");
    expect(body.size).toBe(bytes.byteLength);
    expect(body.sha256).toBe(sha256Hex(bytes));

    const [row] = await db.select().from(documents).where(eq(documents.id, body.id));
    expect(row).toBeDefined();
    expect(row!.purpose).toBe("agent_output");
    expect(row!.runId).toBe(runId);
    expect(row!.orgId).toBe(ctx.orgId);
    expect(row!.size).toBe(bytes.byteLength);
    expect(await orgBytesUsed(ctx.orgId)).toBe(bytes.byteLength);
  });

  it("dedups an identical (sha256, name) re-publish: 200, existing row, single count", async () => {
    const runId = await seedRun(ctx);
    const bytes = new TextEncoder().encode("idempotent-body");
    const h = () => docHeaders(RUN_SECRET, "out.txt");

    const first = await postDoc(runId, h(), bytes);
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { id: string }).id;

    const second = await postDoc(runId, h(), bytes);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { id: string }).id).toBe(firstId);

    const rows = await db.select().from(documents).where(eq(documents.runId, runId));
    expect(rows.length).toBe(1);
    expect(await orgBytesUsed(ctx.orgId)).toBe(bytes.byteLength);
  });

  it("rejects a run that is not running: 409", async () => {
    const runId = await seedRun(ctx, { status: "pending" });
    const res = await postDoc(runId, docHeaders(RUN_SECRET, "x.txt"), new Uint8Array([1, 2, 3]));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("run_not_running");
  });

  it("returns 404 for an unknown run", async () => {
    const res = await postDoc("run_missing", docHeaders(RUN_SECRET, "x.txt"), new Uint8Array([1]));
    expect(res.status).toBe(404);
  });

  it("cuts an over-per-file-cap upload mid-stream: 413, no row, no counter, no partial", async () => {
    const runId = await seedRun(ctx);
    await withEnv("DOCUMENT_MAX_FILE_BYTES", "8", async () => {
      const bytes = new TextEncoder().encode("way too many bytes for the cap");
      const res = await postDoc(runId, docHeaders(RUN_SECRET, "big.txt"), bytes);
      expect(res.status).toBe(413);
      expect(((await res.json()) as { detail: string }).detail).toContain("per-file");
      const rows = await db.select().from(documents).where(eq(documents.runId, runId));
      expect(rows.length).toBe(0);
      expect(await orgBytesUsed(ctx.orgId)).toBe(0);
    });
  });

  it("rejects over the per-run output budget with a distinct 413", async () => {
    const runId = await seedRun(ctx);
    await withEnv("RUN_MAX_OUTPUT_BYTES", "4", async () => {
      const bytes = new TextEncoder().encode("more-than-four");
      const res = await postDoc(runId, docHeaders(RUN_SECRET, "run.txt"), bytes);
      expect(res.status).toBe(413);
      expect(((await res.json()) as { detail: string }).detail).toContain("per-run");
      expect(await orgBytesUsed(ctx.orgId)).toBe(0);
    });
  });

  it("rejects over the org storage quota: 403 storage_limit_exceeded", async () => {
    const runId = await seedRun(ctx);
    await withEnv("ORG_STORAGE_QUOTA_BYTES", "4", async () => {
      const bytes = new TextEncoder().encode("exceeds-quota");
      const res = await postDoc(runId, docHeaders(RUN_SECRET, "quota.txt"), bytes);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("storage_limit_exceeded");
      const rows = await db.select().from(documents).where(eq(documents.runId, runId));
      expect(rows.length).toBe(0);
      expect(await orgBytesUsed(ctx.orgId)).toBe(0);
    });
  });

  describe("authentication", () => {
    it("accepts a valid run signature", async () => {
      const runId = await seedRun(ctx);
      const res = await postDoc(runId, docHeaders(RUN_SECRET, "ok.txt"), new Uint8Array([1, 2]));
      expect(res.status).toBe(201);
    });

    it("rejects a cookie/API-key request with no run signature: 401", async () => {
      const runId = await seedRun(ctx);
      const res = await postDoc(
        runId,
        {
          ...authHeaders(ctx),
          "X-Document-Name": "cookie.txt",
          "Content-Type": "text/plain",
        },
        new Uint8Array([1, 2, 3]),
      );
      expect(res.status).toBe(401);
    });

    it("rejects a signature from the wrong run secret: 401", async () => {
      const runId = await seedRun(ctx);
      const res = await postDoc(
        runId,
        docHeaders("b".repeat(43), "wrong.txt"),
        new Uint8Array([1, 2, 3]),
      );
      expect(res.status).toBe(401);
    });
  });
});
