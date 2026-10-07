// SPDX-License-Identifier: Apache-2.0

/**
 * Keeps the live model catalog (`model-catalog-overlay.ts`) current: each API
 * process reads the channel's file for its Pi version when it starts and every
 * hour, and holds the accepted one in memory. Nothing is stored. A process that
 * cannot read the channel serves the bundled registry and the file it already
 * holds; one that just started holds none until its first read lands.
 *
 * The channel cannot forge a file, nor hand a process an older one than it
 * holds. It can withhold a newer one.
 */

import { getEnv } from "@appstrate/env";
import { getErrorMessage } from "@appstrate/core/errors";
import { PI_SDK_VERSION } from "@appstrate/runner-pi/provider-map";
import { readBodyUnder } from "../lib/capped-body.ts";
import { logger } from "../lib/logger.ts";
import {
  applyModelCatalog,
  heldModelCatalogSerial,
  ModelCatalogRefused,
  readModelCatalog,
} from "./model-catalog-overlay.ts";

/** Pi's whole registry is under 1 MB. */
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const REFRESH_INTERVAL_MS = 60 * 60_000;

interface ModelCatalogSyncOptions {
  publicKey?: string;
  url?: string;
  fetch?: typeof fetch;
}

/** A body as UTF-8 text under `maxBytes`. The exact bytes are what was signed. */
async function readText(response: Response, maxBytes: number): Promise<string> {
  const bytes = await readBodyUnder(response, maxBytes);
  if (bytes === null) throw new ModelCatalogRefused(`larger than ${maxBytes} bytes`);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

/**
 * Read the channel's file and serve it. Throws on an unreachable channel or a
 * refused file: the one held stays. `absent`: no file for this Pi version.
 */
export async function refreshModelCatalog(
  options: ModelCatalogSyncOptions = {},
): Promise<"absent" | "unchanged" | "applied"> {
  const base = options.url ?? getEnv().MODEL_CATALOG_URL;
  const fetchImpl = options.fetch ?? fetch;
  const fileUrl = `${base.replace(/\/+$/, "")}/pi-${PI_SDK_VERSION}.json`;
  const get = (url: string) =>
    fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

  const response = await get(fileUrl);
  if (response.status === 404) return "absent";
  if (!response.ok) throw new Error(`model catalog channel answered ${response.status}`);
  const payload = await readText(response, MAX_CATALOG_BYTES);
  const signatureResponse = await get(`${fileUrl}.sig`);
  if (!signatureResponse.ok) {
    throw new Error(`model catalog signature answered ${signatureResponse.status}`);
  }
  const signature = (await readText(signatureResponse, 1_024)).trim();
  const catalog = await readModelCatalog(payload, signature, options.publicKey);

  // A serial names one file: the one held again is no news, a lower one is a rollback.
  const held = heldModelCatalogSerial();
  if (held !== null && catalog.serial === held) return "unchanged";
  if (held !== null && catalog.serial < held) {
    throw new ModelCatalogRefused(`serial ${catalog.serial} is older than the ${held} held`);
  }
  applyModelCatalog(catalog);
  logger.info("model catalog applied", {
    serial: catalog.serial,
    sourceVersion: catalog.sourceVersion,
    models: catalog.models.length,
    skipped: catalog.skipped.length,
    ...(catalog.skipped.length > 0 ? { skippedSample: catalog.skipped.slice(0, 10) } : {}),
  });
  return "applied";
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Read the channel now and every hour, in the background: boot never waits on
 * the network. An empty `MODEL_CATALOG_URL` starts nothing. Idempotent.
 */
export function startModelCatalogSync(options: ModelCatalogSyncOptions = {}): void {
  if (timer || !(options.url ?? getEnv().MODEL_CATALOG_URL)) return;
  const refresh = () =>
    void refreshModelCatalog(options).catch((err) => {
      logger.warn("model catalog not refreshed — serving what this process holds", {
        error: getErrorMessage(err),
      });
    });
  refresh();
  timer = setInterval(refresh, REFRESH_INTERVAL_MS);
  timer.unref?.();
}

export function stopModelCatalogSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
