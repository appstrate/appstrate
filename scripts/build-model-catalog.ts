#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Build and sign the live model catalog for this checkout's Pi version
 * (`docs/architecture/MODEL_CATALOG.md`): the models a later Pi registry
 * records that the pinned Pi code can serve.
 *
 *   bun run build:model-catalog --data <dir> --source-version <version> --out <dir>
 *
 * `--data` is `dist/providers/data` of a later `@earendil-works/pi-ai`, read
 * as JSON: nothing of that package is imported or run. Writes
 * `pi-<PI_SDK_VERSION>.json` and its `.sig` under `--out` unless the file there
 * already lists the same records under a signature this checkout accepts.
 * `MODEL_CATALOG_SIGNING_KEY` is the base64 raw Ed25519 seed; a key pair comes
 * from `bun scripts/sign-firecracker-manifest.ts --generate`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { getErrorMessage } from "@appstrate/core/errors";
import {
  type CatalogRecord,
  parseModelCatalog,
  readModelCatalog,
} from "../apps/api/src/services/model-catalog-overlay.ts";
import {
  buildPiModel,
  findPiModelsById,
  listPiModels,
  listPiModelsOfApi,
  piReasoningLevels,
} from "../packages/runner-pi/src/pi-model.ts";
import { PI_SDK_VERSION } from "../packages/runner-pi/src/provider-map.ts";
import { capturePayload, recordSpec } from "../packages/runner-pi/test/pi-payload.ts";

const SECRET_ENV = "MODEL_CATALOG_SIGNING_KEY";
/** PKCS#8 DER prefix of an Ed25519 private key (RFC 8410); the raw seed follows. */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** A record of a Pi data file, as Pi wrote it. */
interface SourceRecord extends Record<string, unknown> {
  type: string;
  provider: string;
  api: string;
  id: string;
  baseUrl: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isSourceRecord(value: unknown): value is SourceRecord {
  return (
    isObject(value) &&
    ["type", "provider", "api", "id", "baseUrl"].every((key) => typeof value[key] === "string")
  );
}

export interface DroppedRecord {
  provider: string;
  id: string;
  reason: string;
}

/**
 * The chat records of a Pi data directory, as Pi's own loader flattens them:
 * one file per provider, the last record of an id winning. Any other layout throws.
 */
export function readChatRecords(dataDir: string): SourceRecord[] {
  const records: SourceRecord[] = [];
  for (const name of readdirSync(dataDir).sort()) {
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    const provider = name.slice(0, -".json".length);
    // One data file: API shape → record key → record.
    const groups: unknown = JSON.parse(readFileSync(join(dataDir, name), "utf8"));
    if (!isObject(groups)) throw new Error(`${name}: not a map of API shapes`);
    const byId = new Map<string, SourceRecord>();
    for (const [api, group] of Object.entries(groups)) {
      if (!isObject(group)) throw new Error(`${name}: "${api}" is not a group of records`);
      for (const record of Object.values(group)) {
        if (!isSourceRecord(record)) throw new Error(`${name}: "${api}" holds a non-record`);
        if (record.provider !== provider || record.api !== api) {
          throw new Error(`${name}: record ${record.id} is not filed under its provider and API`);
        }
        if (record.type === "chat") byId.set(record.id, record);
      }
    }
    records.push(...byId.values());
  }
  if (records.length === 0) throw new Error(`${dataDir}: no chat record — not a Pi data directory`);
  return records;
}

const catalogFile = (records: CatalogRecord[], sourceVersion: string, serial: number) => ({
  schema: 1,
  sdk_version: PI_SDK_VERSION,
  source_version: sourceVersion,
  serial,
  records,
});

/** The fields an instance builds a model from; the rest is weighed, never copied. */
function toCatalogRecord(source: SourceRecord): CatalogRecord {
  const { provider, api, id, name, reasoning, input, cost, contextWindow, maxTokens } = source;
  const { thinkingLevelMap, compat } = source;
  return {
    ...{ provider, api, id, name, reasoning, input, cost, contextWindow, maxTokens },
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    ...(compat === undefined ? {} : { compat }),
  } as CatalogRecord;
}

/**
 * Why this checkout must not publish `source`, or null. On top of the
 * instance's own rules: a field or an endpoint no bundled sibling has may be
 * one the model needs, and the pinned code must build its request at every level.
 */
async function recordRefusal(source: SourceRecord): Promise<string | null> {
  const known = new Set(listPiModelsOfApi(source.api).flatMap((record) => Object.keys(record)));
  const unknown = Object.keys(source).find((key) => !known.has(key));
  if (unknown && known.size > 0) return `unknown field "${unknown}"`;
  const siblings = listPiModels(source.provider, source.api);
  if (siblings.length > 0 && !siblings.some((record) => record.baseUrl === source.baseUrl)) {
    return "served from an endpoint no bundled record of its provider uses";
  }
  let accepted;
  try {
    accepted = parseModelCatalog(JSON.stringify(catalogFile([toCatalogRecord(source)], "0", 0)));
  } catch (err) {
    return getErrorMessage(err);
  }
  const [model] = accepted.models;
  if (!model) return accepted.skipped[0]?.reason ?? "refused";
  const built = buildPiModel({
    id: model.id,
    apiShape: model.api,
    piProvider: model.provider,
    baseUrl: source.baseUrl,
    ...recordSpec(model),
  });
  // Unset first: what a run sends when no level is configured.
  const levels = piReasoningLevels(built).flatMap((level) => (level === "off" ? [] : [level]));
  for (const level of [undefined, ...levels]) {
    try {
      await capturePayload(built, level);
    } catch (err) {
      return `request not built at level ${level ?? "unset"}: ${getErrorMessage(err)}`;
    }
  }
  return null;
}

/** The records of `source` this checkout publishes, sorted, and the ones it drops. */
export async function selectCatalogRecords(
  source: SourceRecord[],
): Promise<{ records: CatalogRecord[]; dropped: DroppedRecord[] }> {
  const records: CatalogRecord[] = [];
  const dropped: DroppedRecord[] = [];
  for (const candidate of source) {
    const { provider, id } = candidate;
    // Additive only: a bundled id is the pinned registry's, and is not news.
    if (findPiModelsById(id).some((bundled) => bundled.provider === provider)) continue;
    const reason = await recordRefusal(candidate);
    if (reason) dropped.push({ provider, id, reason });
    else records.push(toCatalogRecord(candidate));
  }
  // Code-unit order: the same on every runner, so an unchanged set compares equal.
  const key = (r: { provider: string; id: string }) => `${r.provider}\u0000${r.id}`;
  const order = (a: Parameters<typeof key>[0], b: Parameters<typeof key>[0]) =>
    key(a) < key(b) ? -1 : 1;
  return { records: records.sort(order), dropped: dropped.sort(order) };
}

function statedSerial(payload: string): number {
  try {
    const serial: unknown = (JSON.parse(payload) as { serial?: unknown }).serial;
    return typeof serial === "number" && Number.isSafeInteger(serial) ? serial : -1;
  } catch {
    return -1;
  }
}

async function sign(payload: string, seedBase64: string): Promise<string> {
  const seed = Buffer.from(seedBase64.trim(), "base64");
  if (seed.length !== 32) throw new Error(`${SECRET_ENV} must be a base64 raw 32-byte seed`);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    "Ed25519",
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(payload));
  return Buffer.from(signature).toString("base64");
}

interface BuildOptions {
  dataDir: string;
  sourceVersion: string;
  previous?: { payload: string; signature: string };
  seed: string;
  publicKey?: string;
  now?: () => number;
}

export interface BuiltCatalog {
  /** Null when the published file already lists these records. */
  file: { payload: string; signature: string } | null;
  records: CatalogRecord[];
  dropped: DroppedRecord[];
}

export async function buildModelCatalog(options: BuildOptions): Promise<BuiltCatalog> {
  // What a registry no later than the pinned one lists beyond it was removed.
  const later = Bun.semver.order(options.sourceVersion, PI_SDK_VERSION) > 0;
  const { records, dropped } = later
    ? await selectCatalogRecords(readChatRecords(options.dataDir))
    : { records: [], dropped: [] };

  // A published file this checkout refuses (another key, damaged bytes) is
  // published again, above its serial when it still states one.
  let previousSerial = -1;
  if (options.previous) {
    const { payload, signature } = options.previous;
    const accepted = await readModelCatalog(payload, signature, options.publicKey).catch(
      () => null,
    );
    const published = accepted ? (JSON.parse(payload) as { records: unknown }) : null;
    if (published && JSON.stringify(published.records) === JSON.stringify(records)) {
      return { file: null, records, dropped };
    }
    previousSerial = accepted?.serial ?? statedSerial(payload);
  }

  // A serial only grows, whatever the clock says.
  const now = Math.floor((options.now ?? Date.now)() / 1000);
  const serial = Math.max(now, previousSerial + 1);
  const payload = `${JSON.stringify(catalogFile(records, options.sourceVersion, serial), null, 2)}\n`;
  const signature = await sign(payload, options.seed);
  // Read back as an instance reads it: a seed that is not the pinned key's fails here.
  const accepted = await readModelCatalog(payload, signature, options.publicKey);
  if (accepted.skipped.length > 0 || accepted.models.length !== records.length) {
    throw new Error(`an instance would skip ${JSON.stringify(accepted.skipped)}`);
  }
  return { file: { payload, signature }, records, dropped };
}

export function summarize(built: BuiltCatalog, sourceVersion: string): string {
  const lines = [
    `### Model catalog for Pi ${PI_SDK_VERSION} (from ${sourceVersion})`,
    "",
    built.file ? "Published a new file." : "Unchanged: nothing published.",
    "",
    `**${built.records.length} model(s) listed**`,
    ...built.records.map((r) => `- \`${r.provider}/${r.id}\``),
    "",
    `**${built.dropped.length} record(s) dropped**`,
    ...built.dropped.map((r) => `- \`${r.provider}/${r.id}\`: ${r.reason}`),
  ];
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      data: { type: "string" },
      "source-version": { type: "string" },
      out: { type: "string" },
    },
  });
  const { data: dataDir, "source-version": sourceVersion, out } = values;
  if (!dataDir || !sourceVersion || !out) {
    throw new Error("usage: --data <dir> --source-version <version> --out <dir>");
  }
  const seed = process.env[SECRET_ENV];
  if (!seed) throw new Error(`${SECRET_ENV} is not set`);

  const path = join(out, `pi-${PI_SDK_VERSION}.json`);
  const previous = existsSync(path)
    ? {
        payload: readFileSync(path, "utf8"),
        signature: readFileSync(`${path}.sig`, "utf8").trim(),
      }
    : undefined;
  const built = await buildModelCatalog({ dataDir, sourceVersion, previous, seed });
  if (built.file) {
    mkdirSync(out, { recursive: true });
    writeFileSync(path, built.file.payload);
    writeFileSync(`${path}.sig`, `${built.file.signature}\n`);
  }
  const summary = summarize(built, sourceVersion);
  process.stdout.write(summary);
  const stepSummary = process.env["GITHUB_STEP_SUMMARY"];
  if (stepSummary) writeFileSync(stepSummary, summary, { flag: "a" });
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`build-model-catalog: FAILED — ${getErrorMessage(error)}\n`);
    process.exit(1);
  }
}
