// SPDX-License-Identifier: Apache-2.0

/**
 * Webhooks service — CRUD, signing (Standard Webhooks), and queue-based delivery.
 */

import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { webhooks, webhookDeliveries } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { notFound, invalidRequest, ApiError } from "../lib/errors.ts";
import type { WebhookInfo, WebhookCreateResponse } from "@appstrate/shared-types";
import { isBlockedUrl } from "@appstrate/core/ssrf";
import { toISORequired } from "../lib/date-helpers.ts";
import { buildUpdateSet } from "../lib/db-helpers.ts";
import { createQueue, PermanentJobError } from "../infra/queue/index.ts";
import type { JobQueue, QueueJob } from "../infra/queue/index.ts";
import { isDevEnvironment, LOCALHOST_HOSTS } from "./redirect-validation.ts";
import { prefixedId } from "../lib/ids.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const webhookEventSchema = z.enum([
  "run.started",
  "run.completed",
  "run.failed",
  "run.timeout",
  "run.cancelled",
]);

type WebhookEventType = z.infer<typeof webhookEventSchema>;

/** Delays per attempt (attempt 1 = immediate, attempt 2 = 30s, etc.) */
const RETRY_DELAYS_MS = [30_000, 300_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000, 14_400_000];
const MAX_ATTEMPTS = 8;
const DELIVERY_TIMEOUT_MS = 15_000;
const MAX_WEBHOOKS_PER_APP = 20;
const MAX_PAYLOAD_SIZE = 256 * 1024; // 256KB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DeliveryJobData {
  webhookId: string;
  eventId: string;
  eventType: string;
  payload: string; // JSON string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64 = Buffer.from(bytes).toString("base64url");
  return `whsec_${base64}`;
}

function toWebhookResponse(row: {
  id: string;
  applicationId: string;
  url: string;
  events: string[];
  packageId: string | null;
  payloadMode: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}): WebhookInfo {
  return {
    id: row.id,
    object: "webhook",
    applicationId: row.applicationId,
    url: row.url,
    events: row.events,
    packageId: row.packageId,
    payloadMode: row.payloadMode as "summary" | "full",
    enabled: row.enabled,
    createdAt: toISORequired(row.createdAt),
    updatedAt: toISORequired(row.updatedAt),
  };
}

/**
 * Validate webhook URL — must be HTTPS (http://localhost in dev), not SSRF.
 */
function validateWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidRequest("Malformed URL", "url");
  }

  if (parsed.protocol !== "https:") {
    if (
      !(parsed.protocol === "http:" && LOCALHOST_HOSTS.has(parsed.hostname) && isDevEnvironment())
    ) {
      throw invalidRequest("Only https:// URLs are allowed", "url");
    }
  }

  if (isBlockedUrl(url)) {
    throw invalidRequest("URL resolves to a private or reserved network address", "url");
  }
}

// ---------------------------------------------------------------------------
// Standard Webhooks signing
// ---------------------------------------------------------------------------

async function sign(secret: string, content: string): Promise<string> {
  const key = Buffer.from(secret.replace("whsec_", ""), "base64url");
  const hasher = new Bun.CryptoHasher("sha256", key);
  hasher.update(content);
  return `v1,${Buffer.from(hasher.digest()).toString("base64")}`;
}

async function buildSignedHeaders(
  eventId: string,
  timestamp: number,
  body: string,
  secret: string,
): Promise<Record<string, string>> {
  const content = `${eventId}.${timestamp}.${body}`;
  const signature = await sign(secret, content);

  return {
    "webhook-id": eventId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signature,
    "content-type": "application/json",
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createWebhook(
  orgId: string,
  applicationId: string,
  params: {
    url: string;
    events: string[];
    packageId?: string | null;
    payloadMode?: string;
    enabled?: boolean;
  },
): Promise<WebhookCreateResponse> {
  // Check limit (per application, not per org)
  const existing = await db
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(and(eq(webhooks.orgId, orgId), eq(webhooks.applicationId, applicationId)));
  if (existing.length >= MAX_WEBHOOKS_PER_APP) {
    throw new ApiError({
      status: 400,
      code: "webhook_limit_reached",
      title: "Webhook Limit Reached",
      detail: `Maximum ${MAX_WEBHOOKS_PER_APP} webhooks per application`,
    });
  }

  validateWebhookUrl(params.url);

  const id = prefixedId("wh");
  const secret = generateSecret();

  const [created] = await db
    .insert(webhooks)
    .values({
      id,
      orgId,
      applicationId,
      url: params.url,
      events: params.events,
      packageId: params.packageId ?? null,
      payloadMode: params.payloadMode ?? "full",
      enabled: params.enabled ?? true,
      secret,
    })
    .returning();

  return { ...toWebhookResponse(created!), secret };
}

export async function listWebhooks(orgId: string, applicationId: string): Promise<WebhookInfo[]> {
  const rows = await db
    .select({
      id: webhooks.id,
      applicationId: webhooks.applicationId,
      url: webhooks.url,
      events: webhooks.events,
      packageId: webhooks.packageId,
      payloadMode: webhooks.payloadMode,
      enabled: webhooks.enabled,
      createdAt: webhooks.createdAt,
      updatedAt: webhooks.updatedAt,
    })
    .from(webhooks)
    .where(and(eq(webhooks.orgId, orgId), eq(webhooks.applicationId, applicationId)))
    .orderBy(desc(webhooks.createdAt));

  return rows.map(toWebhookResponse);
}

export async function getWebhook(
  orgId: string,
  applicationId: string,
  webhookId: string,
): Promise<WebhookInfo> {
  const [row] = await db
    .select({
      id: webhooks.id,
      applicationId: webhooks.applicationId,
      url: webhooks.url,
      events: webhooks.events,
      packageId: webhooks.packageId,
      payloadMode: webhooks.payloadMode,
      enabled: webhooks.enabled,
      createdAt: webhooks.createdAt,
      updatedAt: webhooks.updatedAt,
    })
    .from(webhooks)
    .where(
      and(
        eq(webhooks.id, webhookId),
        eq(webhooks.orgId, orgId),
        eq(webhooks.applicationId, applicationId),
      ),
    )
    .limit(1);

  if (!row) throw notFound(`Webhook '${webhookId}' not found`);
  return toWebhookResponse(row);
}

export async function updateWebhook(
  orgId: string,
  applicationId: string,
  webhookId: string,
  params: {
    url?: string;
    events?: string[];
    packageId?: string | null;
    payloadMode?: string;
    enabled?: boolean;
  },
): Promise<WebhookInfo> {
  await getWebhook(orgId, applicationId, webhookId);

  if (params.url) validateWebhookUrl(params.url);

  const updates = buildUpdateSet(params);

  const [updated] = await db
    .update(webhooks)
    .set(updates)
    .where(
      and(
        eq(webhooks.id, webhookId),
        eq(webhooks.orgId, orgId),
        eq(webhooks.applicationId, applicationId),
      ),
    )
    .returning();

  return toWebhookResponse(updated!);
}

export async function deleteWebhook(
  orgId: string,
  applicationId: string,
  webhookId: string,
): Promise<void> {
  await getWebhook(orgId, applicationId, webhookId);
  await db
    .delete(webhooks)
    .where(
      and(
        eq(webhooks.id, webhookId),
        eq(webhooks.orgId, orgId),
        eq(webhooks.applicationId, applicationId),
      ),
    );
}

/** Grace period for the previous secret after rotation (24 hours). */
const SECRET_ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

export async function rotateSecret(
  orgId: string,
  applicationId: string,
  webhookId: string,
): Promise<{ secret: string }> {
  const [row] = await db
    .select({ id: webhooks.id, secret: webhooks.secret })
    .from(webhooks)
    .where(
      and(
        eq(webhooks.id, webhookId),
        eq(webhooks.orgId, orgId),
        eq(webhooks.applicationId, applicationId),
      ),
    )
    .limit(1);

  if (!row) throw notFound(`Webhook '${webhookId}' not found`);

  const newSecret = generateSecret();
  await db
    .update(webhooks)
    .set({
      secret: newSecret,
      previousSecret: row.secret,
      previousSecretExpiresAt: new Date(Date.now() + SECRET_ROTATION_GRACE_MS),
      updatedAt: new Date(),
    })
    .where(eq(webhooks.id, webhookId));

  return { secret: newSecret };
}

export async function listDeliveries(
  orgId: string,
  applicationId: string,
  webhookId: string,
  limit = 20,
): Promise<
  {
    id: string;
    eventId: string;
    eventType: string;
    status: string;
    statusCode: number | null;
    latency: number | null;
    attempt: number;
    error: string | null;
    createdAt: string;
  }[]
> {
  await getWebhook(orgId, applicationId, webhookId);

  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.webhookId, webhookId))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(Math.min(limit, 100));

  return rows.map((r) => ({
    id: r.id,
    eventId: r.eventId,
    eventType: r.eventType,
    status: r.status,
    statusCode: r.statusCode,
    latency: r.latency,
    attempt: r.attempt,
    error: r.error,
    createdAt: toISORequired(r.createdAt),
  }));
}

// ---------------------------------------------------------------------------
// Event envelope builder
// ---------------------------------------------------------------------------

export function buildEventEnvelope(params: {
  eventType: string;
  run: Record<string, unknown>;
  payloadMode: "full" | "summary";
}): { eventId: string; payload: Record<string, unknown> } {
  const eventId = prefixedId("evt");
  const now = Math.floor(Date.now() / 1000);

  const execObj: Record<string, unknown> = { ...params.run, object: "run" };

  // Summary mode: strip result and input
  if (params.payloadMode === "summary") {
    delete execObj.result;
    delete execObj.input;
  }

  // Truncate: if data exceeds 256KB, strip result
  const dataJson = JSON.stringify(execObj);
  if (dataJson.length > MAX_PAYLOAD_SIZE && execObj.result) {
    delete execObj.result;
    execObj.resultTruncated = true;
  }

  return {
    eventId,
    payload: {
      id: eventId,
      object: "event",
      type: params.eventType,
      apiVersion: "2026-03-21",
      created: now,
      data: { object: execObj },
    },
  };
}

// ---------------------------------------------------------------------------
// Delivery queue
// ---------------------------------------------------------------------------

let deliveryQueue: JobQueue<DeliveryJobData> | null = null;

async function getDeliveryQueue(): Promise<JobQueue<DeliveryJobData>> {
  if (!deliveryQueue) {
    deliveryQueue = await createQueue<DeliveryJobData>("webhook-delivery", {
      attempts: MAX_ATTEMPTS,
      backoff: { type: "custom" },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }
  return deliveryQueue;
}

/**
 * Dispatch webhook events for a run status change.
 * Called from the run pipeline after status transitions.
 *
 * All webhooks are application-scoped — fires only for runs in the same application.
 */
export async function dispatchWebhookEvents(
  orgId: string,
  eventType: WebhookEventType,
  run: Record<string, unknown>,
  applicationId: string,
): Promise<void> {
  const rows = await db
    .select({
      id: webhooks.id,
      events: webhooks.events,
      packageId: webhooks.packageId,
      payloadMode: webhooks.payloadMode,
    })
    .from(webhooks)
    .where(
      and(
        eq(webhooks.orgId, orgId),
        eq(webhooks.applicationId, applicationId),
        eq(webhooks.enabled, true),
      ),
    );

  const queue = await getDeliveryQueue();

  for (const wh of rows) {
    if (!wh.events?.includes(eventType)) continue;
    if (wh.packageId && wh.packageId !== run.packageId) continue;

    const { eventId, payload } = buildEventEnvelope({
      eventType,
      run,
      payloadMode: wh.payloadMode as "full" | "summary",
    });

    await queue.add("deliver", {
      webhookId: wh.id,
      eventId,
      eventType,
      payload: JSON.stringify(payload),
    });
  }
}

/**
 * Process a single webhook delivery attempt.
 * Throws on failure — queue handles retry scheduling via backoffStrategy.
 * Throws PermanentJobError for permanent failures (4xx except 408/429).
 */
async function processDelivery(job: QueueJob<DeliveryJobData>): Promise<void> {
  const { webhookId, eventId, eventType, payload } = job.data;
  const attempt = job.attemptsMade + 1; // attemptsMade is 0-based before this attempt

  const [wh] = await db
    .select({
      url: webhooks.url,
      secret: webhooks.secret,
      previousSecret: webhooks.previousSecret,
      previousSecretExpiresAt: webhooks.previousSecretExpiresAt,
    })
    .from(webhooks)
    .where(eq(webhooks.id, webhookId))
    .limit(1);

  if (!wh) {
    logger.warn("Webhook deleted before delivery", { webhookId, eventId });
    return; // Don't retry — webhook is gone
  }

  const timestamp = Math.floor(Date.now() / 1000);

  // Sign with current secret; during grace period, include previous secret signature too
  const headers = await buildSignedHeaders(eventId, timestamp, payload, wh.secret);
  if (wh.previousSecret && wh.previousSecretExpiresAt && wh.previousSecretExpiresAt > new Date()) {
    const content = `${eventId}.${timestamp}.${payload}`;
    const prevSig = await sign(wh.previousSecret, content);
    headers["webhook-signature"] = `${headers["webhook-signature"]} ${prevSig}`;
  }
  headers["webhook-attempt"] = String(attempt);

  const start = Date.now();
  let statusCode: number | undefined;
  let errorMessage: string | undefined;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    const res = await fetch(wh.url, {
      method: "POST",
      headers,
      body: payload,
      signal: controller.signal,
      redirect: "manual", // Do NOT follow redirects (SSRF protection)
    });

    clearTimeout(timeout);
    statusCode = res.status;

    // Drain body to free resources
    await res.text().catch(() => {});
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      errorMessage = "Delivery timeout (15s)";
    } else {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  const latency = Date.now() - start;
  const isSuccess = statusCode !== undefined && statusCode >= 200 && statusCode < 300;
  const isPermanentFailure =
    statusCode !== undefined &&
    statusCode >= 400 &&
    statusCode < 500 &&
    statusCode !== 408 &&
    statusCode !== 429;

  // Record delivery attempt
  await db.insert(webhookDeliveries).values({
    webhookId,
    eventId,
    eventType,
    status: isSuccess ? "success" : "failed",
    statusCode: statusCode ?? null,
    latency,
    attempt,
    error: errorMessage ?? null,
  });

  if (isSuccess) {
    logger.info("Webhook delivered", { webhookId, eventId, statusCode, latency });
    return;
  }

  const failContext = { webhookId, eventId, attempt, statusCode, error: errorMessage, latency };

  // Permanent failure (4xx except 408/429) — do not retry
  if (isPermanentFailure) {
    logger.warn("Webhook delivery permanently failed", failContext);
    throw new PermanentJobError(`Permanent failure: HTTP ${statusCode}`);
  }

  // Transient failure — throw to trigger retry with backoff
  logger.warn("Webhook delivery failed, will retry", failContext);
  throw new Error(errorMessage ?? `HTTP ${statusCode}`);
}

/**
 * Initialize the webhook delivery worker. Called at boot.
 */
export async function initWebhookWorker(): Promise<void> {
  const queue = await getDeliveryQueue();

  queue.process(processDelivery, {
    concurrency: 10,
    limiter: { max: 100, duration: 1000 },
    backoffStrategy: (attemptsMade: number) => {
      return RETRY_DELAYS_MS[attemptsMade - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
    },
  });

  logger.info("Webhook delivery worker started");
}

/**
 * Shutdown the webhook delivery worker. Called during graceful shutdown.
 */
export async function shutdownWebhookWorker(): Promise<void> {
  await deliveryQueue?.shutdown();
  deliveryQueue = null;
}

/**
 * Fire-and-forget webhook dispatch for run status changes.
 * Shared by the run route (POST /run) and the scheduler (triggerScheduledRun).
 */
export function dispatchRunWebhook(
  orgId: string,
  applicationId: string,
  status: string,
  runId: string,
  packageId: string,
  extra?: Record<string, unknown>,
): void {
  const eventType = `run.${status}` as WebhookEventType;
  dispatchWebhookEvents(
    orgId,
    eventType,
    { id: runId, packageId, status, ...extra },
    applicationId,
  ).catch((err) => {
    logger.warn("Webhook dispatch failed", {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
