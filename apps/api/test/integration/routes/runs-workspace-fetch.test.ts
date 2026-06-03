// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the agent self-provisioning fetch:
 * `GET /api/runs/:runId/workspace`.
 *
 * The agent container fetches its workspace archive (AFPS bundle + input
 * documents) from the platform at startup and extracts it locally, instead
 * of relying on a seed-into-the-run-volume step whose correctness depended
 * on the volume driver — a tmpfs-backed `local` volume is not shared between
 * the seed helper and the agent container, so the bundle silently vanished
 * and skills never materialised (issue #549).
 *
 * Auth is the same Standard Webhooks HMAC as event ingestion, here over an
 * empty GET body. These tests pin: the round-trip (upload → signed fetch →
 * identical ZIP bytes), the empty-workspace 404, the closed-sink 410, and
 * the bad-signature 401.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { encrypt } from "@appstrate/connect";
import { sign } from "@appstrate/afps-runtime/events";
import { unzipArtifact } from "@appstrate/core/zip";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import {
  uploadRunWorkspace,
  downloadRunWorkspace,
  deleteRunWorkspace,
} from "../../../src/services/run-workspace-storage.ts";

const app = getTestApp();

const RUN_SECRET = "a".repeat(43); // matches mintSinkCredentials base64url(32 bytes)

function signedGetHeaders(secret: string): Record<string, string> {
  const msgId = `msg_${crypto.randomUUID()}`;
  const timestampSec = Math.floor(Date.now() / 1000);
  // The HMAC covers the (empty) GET body — exactly what the agent runtime signs.
  const headers = sign({ msgId, timestampSec, body: "", secret });
  return {
    "webhook-id": headers["webhook-id"],
    "webhook-timestamp": headers["webhook-timestamp"],
    "webhook-signature": headers["webhook-signature"],
  };
}

async function seedRunWithSink(
  ctx: TestContext,
  packageId: string,
  overrides: { sinkClosedAt?: Date | null; sinkExpiresAt?: Date } = {},
): Promise<string> {
  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(runs).values({
    id: runId,
    packageId,
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    status: "running",
    runOrigin: "platform",
    sinkSecretEncrypted: encrypt(RUN_SECRET),
    sinkExpiresAt: overrides.sinkExpiresAt ?? new Date(Date.now() + 3600_000),
    sinkClosedAt: overrides.sinkClosedAt ?? null,
    startedAt: new Date(),
  });
  return runId;
}

describe("run-workspace storage round-trip", () => {
  it("uploads, downloads, and deletes a workspace archive", async () => {
    const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const files = [
      { name: "agent-package.afps", content: Buffer.from("PACKAGE-BYTES") },
      { name: "documents/report.txt", content: Buffer.from("hello world") },
    ];

    await uploadRunWorkspace(runId, files);

    const archive = await downloadRunWorkspace(runId);
    expect(archive).not.toBeNull();
    const entries = unzipArtifact(new Uint8Array(archive!));
    expect(new TextDecoder().decode(entries["agent-package.afps"])).toBe("PACKAGE-BYTES");
    expect(new TextDecoder().decode(entries["documents/report.txt"])).toBe("hello world");

    await deleteRunWorkspace(runId);
    expect(await downloadRunWorkspace(runId)).toBeNull();
  });

  it("uploadRunWorkspace is a no-op when there are no files", async () => {
    const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await uploadRunWorkspace(runId, []);
    expect(await downloadRunWorkspace(runId)).toBeNull();
  });

  it("deleteRunWorkspace never throws on a missing object", async () => {
    const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await deleteRunWorkspace(runId); // must not throw
    expect(await downloadRunWorkspace(runId)).toBeNull();
  });
});

describe("GET /api/runs/:runId/workspace", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ email: "ws@test.dev", orgSlug: "ws-org" });
    await seedPackage({ orgId: ctx.orgId, id: "@test/ws-agent", type: "agent" });
  });

  it("returns the provisioned archive verbatim to a signed request", async () => {
    const runId = await seedRunWithSink(ctx, "@test/ws-agent");
    const files = [
      { name: "agent-package.afps", content: Buffer.from("BUNDLE") },
      { name: "documents/a.txt", content: Buffer.from("doc-a") },
    ];
    await uploadRunWorkspace(runId, files);

    const res = await app.request(`/api/runs/${runId}/workspace`, {
      method: "GET",
      headers: signedGetHeaders(RUN_SECRET),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const archive = new Uint8Array(await res.arrayBuffer());
    const entries = unzipArtifact(archive);
    expect(new TextDecoder().decode(entries["agent-package.afps"])).toBe("BUNDLE");
    expect(new TextDecoder().decode(entries["documents/a.txt"])).toBe("doc-a");

    await deleteRunWorkspace(runId);
  });

  it("returns 404 when no workspace was provisioned (empty workspace)", async () => {
    const runId = await seedRunWithSink(ctx, "@test/ws-agent");
    const res = await app.request(`/api/runs/${runId}/workspace`, {
      method: "GET",
      headers: signedGetHeaders(RUN_SECRET),
    });
    expect(res.status).toBe(404);
  });

  it("rejects an invalid signature with 401", async () => {
    const runId = await seedRunWithSink(ctx, "@test/ws-agent");
    await uploadRunWorkspace(runId, [
      { name: "agent-package.afps", content: Buffer.from("BUNDLE") },
    ]);

    const res = await app.request(`/api/runs/${runId}/workspace`, {
      method: "GET",
      headers: signedGetHeaders("wrong-secret-".repeat(3)),
    });
    expect(res.status).toBe(401);

    await deleteRunWorkspace(runId);
  });

  it("rejects a closed sink with 410", async () => {
    const runId = await seedRunWithSink(ctx, "@test/ws-agent", { sinkClosedAt: new Date() });
    await uploadRunWorkspace(runId, [
      { name: "agent-package.afps", content: Buffer.from("BUNDLE") },
    ]);

    const res = await app.request(`/api/runs/${runId}/workspace`, {
      method: "GET",
      headers: signedGetHeaders(RUN_SECRET),
    });
    expect(res.status).toBe(410);

    await deleteRunWorkspace(runId);
  });

  it("returns 404 for an unknown run", async () => {
    const res = await app.request(`/api/runs/run_does_not_exist/workspace`, {
      method: "GET",
      headers: signedGetHeaders(RUN_SECRET),
    });
    expect(res.status).toBe(404);
  });
});
