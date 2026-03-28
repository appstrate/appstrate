/**
 * Webhooks service — CRUD, signing (Standard Webhooks), and BullMQ delivery.
 */

import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { Queue, Worker, UnrecoverableError } from "bullmq";
import type { Job } from "bullmq";
import { db } from "@appstrate/db/client";
import { webhooks, webhookDeliveries } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { notFound, invalidRequest, ApiError } from "../lib/errors.ts";
import type { WebhookInfo, WebhookCreateResponse } from "@appstrate/shared-types";
import { isBlockedUrl } from "@appstrate/core/ssrf";
import { getRedisConnection } from "../lib/redis.ts";
import { getEnv } from "@appstrate/env";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const webhookEventSchema = z.enum([
  "execution.started",
  "execution.completed",
  "execution.failed",
  "execution.timeout",
  "execution.cancelled",
]);

export type WebhookEventType = z.infer<typeof webhookEventSchema>;

export const webhookEventsSchema = z.array(webhookEventSchema).min(1);

/** Delays per attempt (attempt 1 = immediate, attempt 2 = 30s, etc.) */
const RETRY_DELAYS_MS = [30_000, 300_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000, 14_400_000];
const MAX_ATTEMPTS = 8;
const DELIVERY_TIMEOUT_MS = 15_000;
const MAX_WEBHOOKS_PER_ORG = 20;
const MAX_PAYLOAD_SIZE = 256 * 1024; // 256KB
const SECRET_ROTATION_GRACE_MS = 24 * 60 * 60 * 1000; // 24h

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

function generateWebhookId(): string {
  return `wh_${crypto.randomUUID()}`;
}

function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64 = Buffer.from(bytes).toString("base64url");
  return `whsec_${base64}`;
}

function generateEventId(): string {
  return `evt_${crypto.randomUUID()}`;
}

function toWebhookResponse(row: {
  id: string;
  url: string;
  events: string[] | null;
  packageId: string | null;
  payloadMode: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}): WebhookInfo {
  return {
    id: row.id,
    object: "webhook",
    url: row.url,
    events: row.events ?? [],
    packageId: row.packageId,
    payloadMode: row.payloadMode === "summary" ? "summary" : "full",
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Validate webhook URL — must be HTTPS (http://localhost in dev), not SSRF.
 */
export function validateWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidRequest("Malformed URL", "url");
  }

  const isDev = (() => {
    try {
      return ["localhost", "127.0.0.1"].includes(new URL(getEnv().APP_URL).hostname);
    } catch {
      return false;
    }
  })();

  if (parsed.protocol !== "https:") {
    if (
      !(
        parsed.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(parsed.hostname) &&
        isDev
      )
    ) {
      throw invalidRequest("Only https:// URLs are allowed", "url");
    }
  }

  if (isBlockedUrl(url)) {
    throw invalidRequest("URL resolves to a private or reserved network address", "url");
  }
}

export function validateEvents(events: unknown): string[] {
  if (!Array.isArray(events) || events.length === 0) {
    throw invalidRequest("events must be a non-empty array", "events");
  }
  const result = webhookEventsSchema.safeParse(events);
  if (!result.success) {
    // Find the first invalid value for a clear error message
    const invalid = events.find((e) => !webhookEventSchema.safeParse(e).success);
    throw invalidRequest(`Invalid event type: '${invalid}'`, "events");
  }
  return result.data;
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

export async function buildSignedHeaders(
  eventId: string,
  timestamp: number,
  body: string,
  secret: string,
  previousSecret?: string | null,
): Promise<Record<string, string>> {
  const content = `${eventId}.${timestamp}.${body}`;
  const sig = await sign(secret, content);

  let signature = sig;
  if (previousSecret) {
    const prevSig = await sign(previousSecret, content);
    signature = `${sig} ${prevSig}`; // Standard Webhooks: space-separated
  }

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
    active?: boolean;
  },
): Promise<WebhookCreateResponse> {
  // Check limit
  const existing = await db
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(eq(webhooks.orgId, orgId));
  if (existing.length >= MAX_WEBHOOKS_PER_ORG) {
    throw new ApiError({
      status: 400,
      code: "webhook_limit_reached",
      title: "Webhook Limit Reached",
      detail: `Maximum ${MAX_WEBHOOKS_PER_ORG} webhooks per organization`,
    });
  }

  validateWebhookUrl(params.url);
  const validatedEvents = validateEvents(params.events);

  const id = generateWebhookId();
  const secret = generateSecret();

  const [created] = await db
    .insert(webhooks)
    .values({
      id,
      orgId,
      applicationId,
      url: params.url,
      events: validatedEvents,
      packageId: params.packageId ?? null,
      payloadMode: params.payloadMode ?? "full",
      active: params.active ?? true,
      secret,
    })
    .returning();

  return { ...toWebhookResponse(created!), secret };
}

export async function listWebhooks(orgId: string, applicationId?: string): Promise<WebhookInfo[]> {
  const conditions = [eq(webhooks.orgId, orgId)];
  if (applicationId) {
    conditions.push(eq(webhooks.applicationId, applicationId));
  }

  const rows = await db
    .select({
      id: webhooks.id,
      url: webhooks.url,
      events: webhooks.events,
      packageId: webhooks.packageId,
      payloadMode: webhooks.payloadMode,
      active: webhooks.active,
      createdAt: webhooks.createdAt,
      updatedAt: webhooks.updatedAt,
    })
    .from(webhooks)
    .where(and(...conditions))
    .orderBy(desc(webhooks.createdAt));

  return rows.map(toWebhookResponse);
}

export async function getWebhook(orgId: string, webhookId: string): Promise<WebhookInfo> {
  const [row] = await db
    .select({
      id: webhooks.id,
      url: webhooks.url,
      events: webhooks.events,
      packageId: webhooks.packageId,
      payloadMode: webhooks.payloadMode,
      active: webhooks.active,
      createdAt: webhooks.createdAt,
      updatedAt: webhooks.updatedAt,
    })
    .from(webhooks)
    .where(and(eq(webhooks.id, webhookId), eq(webhooks.orgId, orgId)))
    .limit(1);

  if (!row) throw notFound(`Webhook '${webhookId}' not found`);
  return toWebhookResponse(row);
}

export async function updateWebhook(
  orgId: string,
  webhookId: string,
  params: {
    url?: string;
    events?: string[];
    packageId?: string | null;
    payloadMode?: string;
    active?: boolean;
  },
): Promise<WebhookInfo> {
  await getWebhook(orgId, webhookId);

  if (params.url) validateWebhookUrl(params.url);
  if (params.events) validateEvents(params.events);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (params.url !== undefined) updates.url = params.url;
  if (params.events !== undefined) updates.events = params.events;
  if (params.packageId !== undefined) updates.packageId = params.packageId;
  if (params.payloadMode !== undefined) updates.payloadMode = params.payloadMode;
  if (params.active !== undefined) updates.active = params.active;

  const [updated] = await db
    .update(webhooks)
    .set(updates)
    .where(and(eq(webhooks.id, webhookId), eq(webhooks.orgId, orgId)))
    .returning();

  return toWebhookResponse(updated!);
}

export async function deleteWebhook(orgId: string, webhookId: string): Promise<void> {
  await getWebhook(orgId, webhookId);
  await db.delete(webhooks).where(and(eq(webhooks.id, webhookId), eq(webhooks.orgId, orgId)));
}

export async function rotateSecret(orgId: string, webhookId: string): Promise<{ secret: string }> {
  const [row] = await db
    .select({ id: webhooks.id, secret: webhooks.secret })
    .from(webhooks)
    .where(and(eq(webhooks.id, webhookId), eq(webhooks.orgId, orgId)))
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
  await getWebhook(orgId, webhookId);

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
    createdAt: r.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Event envelope builder
// ---------------------------------------------------------------------------

export function buildEventEnvelope(params: {
  eventType: string;
  execution: Record<string, unknown>;
  payloadMode: "full" | "summary";
}): { eventId: string; payload: Record<string, unknown> } {
  const eventId = generateEventId();
  const now = Math.floor(Date.now() / 1000);

  const execObj: Record<string, unknown> = { ...params.execution, object: "execution" };

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
// BullMQ delivery queue
// ---------------------------------------------------------------------------

let deliveryQueue: Queue<DeliveryJobData> | null = null;
let deliveryWorker: Worker<DeliveryJobData> | null = null;

function getDeliveryQueue(): Queue<DeliveryJobData> {
  if (!deliveryQueue) {
    deliveryQueue = new Queue<DeliveryJobData>("webhook-delivery", {
      connection: getRedisConnection() as never,
      defaultJobOptions: {
        attempts: MAX_ATTEMPTS,
        backoff: { type: "custom" },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }
  return deliveryQueue;
}

/**
 * Dispatch webhook events for an execution status change.
 * Called from the execution pipeline after status transitions.
 */
export async function dispatchWebhookEvents(
  orgId: string,
  eventType: WebhookEventType,
  execution: Record<string, unknown>,
  applicationId?: string | null,
): Promise<void> {
  // Webhooks are application-scoped — skip dispatch if no application context
  if (!applicationId) return;

  const conditions = [
    eq(webhooks.orgId, orgId),
    eq(webhooks.active, true),
    eq(webhooks.applicationId, applicationId),
  ];

  const rows = await db
    .select({
      id: webhooks.id,
      events: webhooks.events,
      packageId: webhooks.packageId,
      payloadMode: webhooks.payloadMode,
    })
    .from(webhooks)
    .where(and(...conditions));

  const queue = getDeliveryQueue();

  for (const wh of rows) {
    if (!wh.events?.includes(eventType)) continue;
    if (wh.packageId && wh.packageId !== execution.packageId) continue;

    const { eventId, payload } = buildEventEnvelope({
      eventType,
      execution,
      payloadMode:
        wh.payloadMode === "full" || wh.payloadMode === "summary" ? wh.payloadMode : "full",
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
 * Throws on failure — BullMQ handles retry scheduling via backoffStrategy.
 * Throws UnrecoverableError for permanent failures (4xx except 408/429).
 */
async function processDelivery(job: Job<DeliveryJobData>): Promise<void> {
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

  // Determine active secrets (handle rotation grace period)
  const prevSecret =
    wh.previousSecret && wh.previousSecretExpiresAt && wh.previousSecretExpiresAt > new Date()
      ? wh.previousSecret
      : null;

  const headers = await buildSignedHeaders(eventId, timestamp, payload, wh.secret, prevSecret);
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
    throw new UnrecoverableError(`Permanent failure: HTTP ${statusCode}`);
  }

  // Transient failure — throw to trigger BullMQ retry with backoff
  logger.warn("Webhook delivery failed, will retry", failContext);
  throw new Error(errorMessage ?? `HTTP ${statusCode}`);
}

/**
 * Initialize the webhook delivery worker. Called at boot.
 */
export function initWebhookWorker(): void {
  if (deliveryWorker) return;

  deliveryWorker = new Worker<DeliveryJobData>("webhook-delivery", processDelivery, {
    connection: getRedisConnection() as never,
    concurrency: 10,
    limiter: {
      max: 100,
      duration: 1000, // 100 deliveries/sec
    },
    settings: {
      backoffStrategy: (attemptsMade: number) => {
        // attemptsMade is 1-based here (1 = first retry after first failure)
        return RETRY_DELAYS_MS[attemptsMade - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
      },
    },
  });

  deliveryWorker.on("failed", (job, err) => {
    if (err instanceof UnrecoverableError) return; // Already logged in processDelivery
    logger.error("Webhook delivery job failed", {
      jobId: job?.id,
      error: err.message,
    });
  });

  logger.info("Webhook delivery worker started");
}

/**
 * Shutdown the webhook delivery worker. Called during graceful shutdown.
 */
export async function shutdownWebhookWorker(): Promise<void> {
  await deliveryWorker?.close();
  await deliveryQueue?.close();
  deliveryWorker = null;
  deliveryQueue = null;
}
