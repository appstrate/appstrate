// SPDX-License-Identifier: Apache-2.0

/**
 * The live model catalog: the models a later Pi registry records and this
 * build's Pi code can serve, read from a signed file so that a new model needs
 * no release (`docs/plans/live-model-catalog.md`, step 2). This module accepts
 * a file and holds it in memory, with no database and no network. The overlay
 * only ADDS to the bundled registry; `model-catalog.ts` decides who reads it.
 */

import { z } from "zod";
import { MODEL_REASONING_LEVELS } from "@appstrate/core/model-generation";
import { modelInputModalitySchema } from "@appstrate/core/module";
import type { Api, Model } from "@appstrate/runner-pi";
import { PLATFORM_MODEL_COMPAT } from "@appstrate/runner-pi/model-compat";
import { findPiModelsById, listPiModels, listPiModelsOfApi } from "@appstrate/runner-pi/pi-model";
import { PI_SDK_VERSION } from "@appstrate/runner-pi/provider-map";

/** Base64 raw Ed25519 public key of the catalog's signing key: in source, never fetched. */
export const MODEL_CATALOG_PUBLIC_KEY = "v1EMfhY2dWAgX24Dbjx/v3LsBLeIA/EDDE3KMUunVcE=";

const rateSchema = {
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
};

/** The fields a model is built from, in Pi's spelling. Strict: no URL, no header. */
const recordSchema = z.strictObject({
  provider: z.string().min(1),
  api: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  reasoning: z.boolean(),
  input: z.array(modelInputModalitySchema).min(1),
  cost: z.strictObject({
    ...rateSchema,
    tiers: z
      .array(z.strictObject({ ...rateSchema, inputTokensAbove: z.number().int().positive() }))
      .optional(),
  }),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  thinkingLevelMap: z.record(z.string(), z.string().nullable()).optional(),
  compat: z.record(z.string(), z.unknown()).optional(),
});

const fileSchema = z.strictObject({
  schema: z.literal(1),
  sdk_version: z.string().min(1),
  source_version: z.string().min(1),
  /** Names one publication and grows with each. */
  serial: z.number().int().nonnegative(),
  records: z.array(recordSchema).max(5_000),
});

type CatalogRecord = z.infer<typeof recordSchema>;

export class ModelCatalogRefused extends Error {}

export interface AcceptedCatalog {
  serial: number;
  sourceVersion: string;
  models: Model<Api>[];
  skipped: Array<{ provider: string; id: string; reason: string }>;
}

const LEVELS: ReadonlySet<string> = new Set(MODEL_REASONING_LEVELS);

/** The words the bundled records of one API use: the ones its pinned code reads. */
interface Vocabulary {
  /** Per compat key: whether a boolean was seen, and every other value seen (as JSON). */
  compat: Map<string, { boolean: boolean; values: Set<string> }>;
  efforts: Set<string>;
}

const vocabularies = new Map<string, Vocabulary>();

function vocabularyOf(api: string): Vocabulary {
  const known = vocabularies.get(api);
  if (known) return known;
  const vocabulary: Vocabulary = { compat: new Map(), efforts: new Set() };
  for (const record of listPiModelsOfApi(api)) {
    for (const effort of Object.values(record.thinkingLevelMap ?? {})) {
      if (typeof effort === "string") vocabulary.efforts.add(effort);
    }
    for (const [key, value] of Object.entries(record.compat ?? {})) {
      const entry = vocabulary.compat.get(key) ?? { boolean: false, values: new Set<string>() };
      if (typeof value === "boolean") entry.boolean = true;
      else entry.values.add(JSON.stringify(value));
      vocabulary.compat.set(key, entry);
    }
  }
  vocabularies.set(api, vocabulary);
  return vocabulary;
}

/**
 * Why this build cannot offer `record`, or null. A word no bundled record of
 * the same API uses is one the pinned code may not know, and a model served
 * with half its dialect is worse than one not offered.
 */
function catalogRecordRefusal(record: CatalogRecord): string | null {
  if (listPiModels(record.provider, record.api).length === 0) {
    return `no bundled record of "${record.provider}" speaks "${record.api}"`;
  }
  // Additive only: prices, limits and dialects of a bundled id change with the SDK bump.
  if (findPiModelsById(record.id).some((bundled) => bundled.provider === record.provider)) {
    return "already in the bundled registry";
  }
  const vocabulary = vocabularyOf(record.api);
  for (const [level, effort] of Object.entries(record.thinkingLevelMap ?? {})) {
    if (!LEVELS.has(level)) return `unknown thinking level "${level}"`;
    if (effort !== null && !vocabulary.efforts.has(effort)) {
      return `unknown effort for thinking level "${level}"`;
    }
  }
  for (const [key, value] of Object.entries(record.compat ?? {})) {
    // Overridden on every model the platform builds: its value is never read.
    if (Object.hasOwn(PLATFORM_MODEL_COMPAT, key)) continue;
    const known = vocabulary.compat.get(key);
    if (!known) return `unknown compat key "${key}"`;
    const spoken =
      typeof value === "boolean" ? known.boolean : known.values.has(JSON.stringify(value));
    if (!spoken) return `unknown value for compat key "${key}"`;
  }
  return null;
}

function toModel(record: CatalogRecord): Model<Api> {
  const { provider, api, thinkingLevelMap, compat, ...rest } = record;
  return {
    ...rest,
    api: api as Api,
    provider,
    // Never read: a model's endpoint is its provider definition's, not the catalog's.
    baseUrl: "",
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(compat ? { compat } : {}),
  } as Model<Api>;
}

async function verifySignature(
  payload: string,
  signature: Uint8Array<ArrayBuffer>,
  publicKey: string,
): Promise<boolean> {
  const key = Buffer.from(publicKey, "base64");
  if (signature.length !== 64 || key.length !== 32) return false;
  const imported = await crypto.subtle.importKey("raw", key, "Ed25519", false, ["verify"]);
  return crypto.subtle.verify("Ed25519", imported, signature, new TextEncoder().encode(payload));
}

/**
 * Throws {@link ModelCatalogRefused} on a bad signature, another Pi version or
 * an unknown shape; a record the pinned code cannot serve is skipped.
 */
export async function readModelCatalog(
  payload: string,
  signature: string,
  publicKey: string = MODEL_CATALOG_PUBLIC_KEY,
): Promise<AcceptedCatalog> {
  if (!(await verifySignature(payload, Buffer.from(signature, "base64"), publicKey))) {
    throw new ModelCatalogRefused("signature does not verify");
  }
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    throw new ModelCatalogRefused("not JSON");
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ModelCatalogRefused(
      `unexpected shape at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`,
    );
  }
  const file = parsed.data;
  if (file.sdk_version !== PI_SDK_VERSION) {
    throw new ModelCatalogRefused(
      `built for Pi ${file.sdk_version}, this instance runs ${PI_SDK_VERSION}`,
    );
  }
  const models: Model<Api>[] = [];
  const skipped: AcceptedCatalog["skipped"] = [];
  const seen = new Set<string>();
  for (const record of file.records) {
    const key = `${record.provider}\u0000${record.id}`;
    const reason = seen.has(key) ? "listed twice" : catalogRecordRefusal(record);
    if (reason) skipped.push({ provider: record.provider, id: record.id, reason });
    else models.push(toModel(record));
    seen.add(key);
  }
  return { serial: file.serial, sourceVersion: file.source_version, models, skipped };
}

let applied: { serial: number; byProvider: Map<string, Model<Api>[]> } | null = null;

/** The serial of the file this process serves, or null on the bundled registry alone. */
export function heldModelCatalogSerial(): number | null {
  return applied?.serial ?? null;
}

/** Replace the applied overlay; `null` goes back to the bundled registry alone. */
export function applyModelCatalog(catalog: AcceptedCatalog | null): void {
  if (!catalog) {
    applied = null;
    return;
  }
  const byProvider = new Map<string, Model<Api>[]>();
  for (const model of catalog.models) {
    byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
  }
  applied = { serial: catalog.serial, byProvider };
}

export function listOverlayModels(piProvider: string, api: string): Model<Api>[] {
  return (applied?.byProvider.get(piProvider) ?? []).filter((model) => model.api === api);
}

/** Every provider's overlay record of `id`, whatever its API shape. */
export function findOverlayModelsById(id: string): Model<Api>[] {
  if (!applied) return [];
  return [...applied.byProvider.values()].flatMap((models) => models.filter((m) => m.id === id));
}
