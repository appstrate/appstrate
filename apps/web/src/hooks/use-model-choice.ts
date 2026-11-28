// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useOpenRouterSearch } from "../components/model-form/use-open-router-search";
import { useModelDiscovery } from "../components/model-form/use-model-discovery";
import type { ProviderRegistryEntry } from "./use-model-provider-credentials";
import type { OrgModelInfo } from "./use-models";
import { buildDiscoverBody } from "@/lib/model-discovery";
import { planModelChoice } from "@/lib/model-choice";
import {
  catalogRows,
  discoveredRows,
  existingRow,
  filterRows,
  modelSource,
  searchRows,
  type ModelPickRow,
} from "@/lib/model-source";

/**
 * What a listing that needs a key asks with: the configuration's organization connection, or a
 * key typed for the occasion (sent with the configuration, which carries a gateway's endpoint).
 */
export type DiscoverWith =
  { credentialId: string } | { inlineApiKey: string; configId: string } | null;

interface ModelChoiceOptions {
  provider: ProviderRegistryEntry;
  /** The models this configuration already makes available. */
  existing: readonly OrgModelInfo[];
  discoverWith: DiscoverWith;
  /**
   * A new configuration: a catalog's recommended models start ticked, a detection's every model;
   * a search ticks nothing (it lists hundreds).
   */
  tickNew: boolean;
}

export function useModelChoice({ provider, existing, discoverWith, tickNew }: ModelChoiceOptions) {
  const source = modelSource(provider);
  const search = useOpenRouterSearch(source === "search");
  const {
    discovery,
    detecting,
    detect: discover,
  } = useModelDiscovery(JSON.stringify(discoverWith));

  // Ids typed by hand: a catalog binds only the ids it offers, anything else may name one.
  const offersManual = source !== "catalog";
  const [typed, setTyped] = useState<ModelPickRow[]>([]);

  const listed = useMemo((): ModelPickRow[] => {
    const offered =
      source === "search"
        ? searchRows(search.models)
        : source === "discover"
          ? discovery?.outcome === "ok"
            ? discoveredRows(discovery.models)
            : []
          : catalogRows(provider.models);
    const ids = new Set(offered.map((r) => r.id));
    return [...offered, ...typed.filter((r) => !ids.has(r.id))];
  }, [source, search.models, discovery, provider.models, typed]);

  // A model the organization has but the listing no longer offers stays in the list (ticked while
  // it has access, unticked once withdrawn).
  const allRows = useMemo(() => {
    const offered = new Set(listed.map((r) => r.id));
    const kept = existing.filter((m) => m.modelId !== null && !offered.has(m.modelId));
    return [...kept.map(existingRow), ...listed];
  }, [listed, existing]);
  const rows = source === "search" ? allRows : filterRows(allRows, search.search);

  // `null` until the first tick: what stands is then derived from the props, so a list that
  // arrives late (a detection) is ticked without an effect.
  const [touched, setTouched] = useState<Map<string, ModelPickRow> | null>(null);
  const initial = useMemo(() => {
    const map = new Map<string, ModelPickRow>();
    // Ticked is access: a row switched off is listed, unticked.
    for (const m of existing)
      if (m.modelId !== null && m.enabled) map.set(m.modelId, existingRow(m));
    if (tickNew && source !== "search") {
      for (const row of listed) if (source === "discover" || row.featured) map.set(row.id, row);
    }
    return map;
  }, [existing, tickNew, source, listed]);
  const picked = touched ?? initial;

  const plan = planModelChoice({ picked, existing });
  const canSave = plan.add.length + plan.grant.length + plan.withdraw.length > 0;

  // The server refuses to switch off the default model: its box stays ticked (the default is
  // changed at the top of the page).
  const lockedId = existing.find((m) => m.is_default)?.modelId ?? null;

  const change = (changed: ModelPickRow[], checked: boolean) => {
    const next = new Map(picked);
    for (const row of changed) {
      if (checked) next.set(row.id, row);
      else if (row.id !== lockedId) next.delete(row.id);
    }
    setTouched(next);
  };

  /** An id typed by hand joins the list, ticked; an id the list already has is just ticked. */
  const addManual = (row: ModelPickRow) => {
    const known = allRows.find((r) => r.id === row.id);
    if (!known) setTyped((rows) => [...rows, row]);
    change([known ?? row], true);
  };

  const detect = () => {
    if (!discoverWith) return;
    discover(
      buildDiscoverBody({
        credentialId: "credentialId" in discoverWith ? discoverWith.credentialId : null,
        providerId: provider.providerId,
        configId: "configId" in discoverWith ? discoverWith.configId : "",
        inlineApiKey: "inlineApiKey" in discoverWith ? discoverWith.inlineApiKey : "",
      }),
    );
  };

  return {
    source,
    rows,
    search,
    picked,
    change,
    plan,
    canSave,
    lockedId,
    offersManual,
    addManual,
    discovery,
    detecting,
    detect,
  };
}

export type ModelChoice = ReturnType<typeof useModelChoice>;
