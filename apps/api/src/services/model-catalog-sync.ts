// SPDX-License-Identifier: Apache-2.0

/**
 * Keeps the live model catalog current: reads the channel's file for this
 * build's Pi version, stores the accepted one, and has every replica serve the
 * stored file. The channel cannot forge a file nor roll an instance back; it
 * can withhold a newer one, and an instance that stored none accepts any file
 * ever published for its Pi version.
 */

import { and, eq, lt, ne, or } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelCatalogOverlays } from "@appstrate/db/schema";
import { getEnv } from "@appstrate/env";
import { getErrorMessage } from "@appstrate/core/errors";
import { PI_SDK_VERSION } from "@appstrate/runner-pi/provider-map";
import { logger } from "../lib/logger.ts";
import {
  appliedModelCatalog,
  applyModelCatalog,
  ModelCatalogRefused,
  readModelCatalog,
} from "./model-catalog-overlay.ts";

/** Pi's whole registry is under 1 MB. */
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

/** How often a process re-reads the stored row: what makes replicas agree. */
const RELOAD_INTERVAL_MS = 60_000;
/** How long the channel's last answer is trusted, across replicas. */
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
/** How long this process waits after an answer that stored nothing. */
const RETRY_INTERVAL_MS = 60 * 60_000;
/** A row of another Pi version unconfirmed for this long is nobody's. */
const ABANDONED_AFTER_MS = 30 * 24 * 60 * 60_000;

interface ModelCatalogSyncOptions {
  publicKey?: string;
  url?: string;
  fetch?: typeof fetch;
}

const ownRow = eq(modelCatalogOverlays.sdkVersion, PI_SDK_VERSION);

/** Signature of the stored file this process refused, warned about once. */
let refused: string | null = null;

/**
 * Serve the stored file, verified again: the row is a copy, not a source of
 * trust. Returns when the channel last confirmed it, or null when none is served.
 */
export async function loadStoredModelCatalog(
  options: ModelCatalogSyncOptions = {},
): Promise<Date | null> {
  const serveNone = () => {
    applyModelCatalog(null);
    return null;
  };
  if (!(options.url ?? getEnv().MODEL_CATALOG_URL)) return serveNone();
  const [head] = await db
    .select({
      signature: modelCatalogOverlays.signature,
      checkedAt: modelCatalogOverlays.checkedAt,
    })
    .from(modelCatalogOverlays)
    .where(ownRow)
    .limit(1);
  if (!head || head.signature === refused) return serveNone();
  if (head.signature === appliedModelCatalog()) return head.checkedAt;

  const [row] = await db.select().from(modelCatalogOverlays).where(ownRow).limit(1);
  if (!row) return serveNone();
  try {
    const catalog = await readModelCatalog(row.payload, row.signature, options.publicKey);
    applyModelCatalog(catalog);
    logger.info("model catalog applied", {
      serial: catalog.serial,
      sourceVersion: catalog.sourceVersion,
      models: catalog.models.length,
      skipped: catalog.skipped.length,
      ...(catalog.skipped.length > 0 ? { skippedSample: catalog.skipped.slice(0, 10) } : {}),
    });
    return row.checkedAt;
  } catch (err) {
    refused = row.signature;
    logger.warn("stored model catalog refused — running on the bundled registry alone", {
      error: getErrorMessage(err),
    });
    return serveNone();
  }
}

/** A response body as UTF-8 text, refused past `maxBytes`. The exact bytes are what was signed. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new ModelCatalogRefused(`larger than ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
}

/** Throws on an unreachable channel or a refused file: the stored one stays. */
export async function fetchModelCatalog(
  options: ModelCatalogSyncOptions = {},
): Promise<"disabled" | "absent" | "stored"> {
  const base = options.url ?? getEnv().MODEL_CATALOG_URL;
  if (!base) return "disabled";
  const fetchImpl = options.fetch ?? fetch;
  const fileUrl = `${base.replace(/\/+$/, "")}/pi-${PI_SDK_VERSION}.json`;
  const get = (url: string) =>
    fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

  const response = await get(fileUrl);
  if (response.status === 404) return "absent";
  if (!response.ok) throw new Error(`model catalog channel answered ${response.status}`);
  const payload = await readCapped(response, MAX_CATALOG_BYTES);
  const signatureResponse = await get(`${fileUrl}.sig`);
  if (!signatureResponse.ok) {
    throw new Error(`model catalog signature answered ${signatureResponse.status}`);
  }
  const signature = (await readCapped(signatureResponse, 1_024)).trim();
  const catalog = await readModelCatalog(payload, signature, options.publicKey);

  const values = { serial: catalog.serial, payload, signature, checkedAt: new Date() };
  const stored = await db
    .insert(modelCatalogOverlays)
    .values({ sdkVersion: PI_SDK_VERSION, ...values })
    .onConflictDoUpdate({
      target: modelCatalogOverlays.sdkVersion,
      set: values,
      // A serial names one file: a lower one is a rollback, and the stored
      // one under other bytes is not the file that was stored.
      setWhere: or(
        lt(modelCatalogOverlays.serial, catalog.serial),
        eq(modelCatalogOverlays.signature, signature),
      ),
    })
    .returning({ serial: modelCatalogOverlays.serial });
  if (stored.length === 0) {
    throw new ModelCatalogRefused(`serial ${catalog.serial} does not follow the stored file's`);
  }
  // The row now holds verified bytes, whatever it held under this signature.
  refused = null;
  // Replicas of another Pi version (a rolling deploy) keep their row.
  await db
    .delete(modelCatalogOverlays)
    .where(
      and(
        ne(modelCatalogOverlays.sdkVersion, PI_SDK_VERSION),
        lt(modelCatalogOverlays.checkedAt, new Date(Date.now() - ABANDONED_AFTER_MS)),
      ),
    );
  return "stored";
}

let timer: ReturnType<typeof setInterval> | null = null;
let nextFetchAt = 0;

/** One pass: serve the stored file, ask the channel when due. Never throws. */
export async function syncModelCatalog(options: ModelCatalogSyncOptions = {}): Promise<void> {
  try {
    const confirmedAt = await loadStoredModelCatalog(options);
    const due = !confirmedAt || Date.now() - confirmedAt.getTime() >= CHECK_INTERVAL_MS;
    if (!due || Date.now() < nextFetchAt) return;
    nextFetchAt = Date.now() + RETRY_INTERVAL_MS;
    if ((await fetchModelCatalog(options)) === "stored") await loadStoredModelCatalog(options);
  } catch (err) {
    logger.warn("model catalog not refreshed — serving the stored file, if any", {
      error: getErrorMessage(err),
    });
  }
}

/** Serve the stored file, then keep it current; the channel is asked in the background. */
export async function startModelCatalogSync(): Promise<void> {
  if (timer) return;
  await loadStoredModelCatalog().catch((err) => {
    logger.warn("stored model catalog not loaded", { error: getErrorMessage(err) });
  });
  void syncModelCatalog();
  timer = setInterval(() => void syncModelCatalog(), RELOAD_INTERVAL_MS);
  timer.unref?.();
}

export function stopModelCatalogSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
  nextFetchAt = 0;
  refused = null;
}
