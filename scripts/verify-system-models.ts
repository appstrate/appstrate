#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-deploy, EVERY release, from the release checkout with the platform env
 * loaded: the boot refuses a `SYSTEM_PROVIDER_KEYS` model outside its
 * provider's offer (Pi's registry — any Pi bump moves it). Prints those
 * provider/model ids, never a key; exits 1 if any. No database.
 */

import { getErrorMessage } from "@appstrate/core/errors";
import { getEnv } from "../packages/env/src/index.ts";
import {
  getModelProvider,
  registerModelProviders,
} from "../apps/api/src/services/model-providers/registry.ts";
import { lookupCatalogModel, restrictsToOffer } from "../apps/api/src/services/model-catalog.ts";
import { getModuleRegistry, importModule } from "../apps/api/src/lib/modules/module-loader.ts";

/** Whether the provider serves `modelId`; null when no registered provider has that id. */
export type Offers = (providerId: string, modelId: string) => boolean | null;

export interface DeclaredSystemModel {
  keyId: string;
  providerId: string;
  modelId: string;
}

const text = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The models `SYSTEM_PROVIDER_KEYS` declares — no key is kept. */
export function declaredSystemModels(entries: readonly unknown[]): DeclaredSystemModel[] {
  return entries.filter(isObject).flatMap((key) => {
    const keyId = text(key.id);
    const providerId = text(key.providerId);
    if (!keyId || !providerId || !Array.isArray(key.models)) return [];
    return key.models.filter(isObject).flatMap((m) => {
      const modelId = text(m.modelId);
      return modelId ? [{ keyId, providerId, modelId }] : [];
    });
  });
}

/** The boot's rule: `outside` fails it; `unregistered` is skipped by it. */
export function checkSystemModels(entries: readonly unknown[], offers: Offers) {
  const declared = declaredSystemModels(entries);
  return {
    outside: declared.filter((m) => offers(m.providerId, m.modelId) === false),
    unregistered: declared.filter((m) => offers(m.providerId, m.modelId) === null),
  };
}

/** The platform registry's answer — the one the boot and the routes gate with. */
export const registryOffers: Offers = (providerId, modelId) => {
  const def = getModelProvider(providerId);
  if (!def) return null;
  return !restrictsToOffer(def) || lookupCatalogModel(def, modelId) !== null;
};

/** Registers the provider definitions of the modules `MODULES` names, without initialising any. */
export async function registerModuleModelProviders(): Promise<string[]> {
  const defs = [];
  for (const specifier of getModuleRegistry()) {
    defs.push(...((await importModule(specifier)).modelProviders?.() ?? []));
  }
  registerModelProviders(defs);
  return defs.map((d) => d.providerId);
}

export const describeSystemModel = (m: DeclaredSystemModel) =>
  `entry "${m.keyId}": ${m.providerId}/${m.modelId}`;

async function main(): Promise<number> {
  const out = (line: string) => process.stdout.write(`${line}\n`);
  out(`providers registered from MODULES: ${(await registerModuleModelProviders()).join(", ")}`);
  const { outside, unregistered } = checkSystemModels(
    getEnv().SYSTEM_PROVIDER_KEYS as unknown[],
    registryOffers,
  );
  for (const m of unregistered)
    out(`skipped at boot — provider not registered: ${describeSystemModel(m)}`);
  for (const m of outside) out(`OUTSIDE the offer — boot refuses: ${describeSystemModel(m)}`);
  out(`SYSTEM_PROVIDER_KEYS models outside the offer: ${outside.length}`);
  return outside.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  let code = 2;
  try {
    code = await main();
  } catch (error) {
    process.stdout.write(`verify-system-models: FAILED — ${getErrorMessage(error)}\n`);
  }
  process.exit(code);
}
