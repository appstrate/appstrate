// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useOpenRouterSearch } from "../components/model-form/use-open-router-search";
import { useDiscoverModels, type ProviderRegistryEntry } from "./use-model-provider-credentials";
import type { OrgModelInfo } from "./use-models";
import { ApiError } from "../api/errors";
import { buildDiscoverBody, type DiscoveryState } from "@/lib/model-discovery";
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

/** What a listing that needs a key asks with: a saved key, or the one being typed. */
export type DiscoverWith =
  { credentialId: string } | { inlineApiKey: string; baseUrl: string } | null;

interface ModelChoiceOptions {
  provider: ProviderRegistryEntry;
  /** The models this provider already makes available. */
  existing: readonly OrgModelInfo[];
  discoverWith: DiscoverWith;
  /** « Add a provider »: everything the listing offers starts ticked. */
  tickAll: boolean;
  /** Offers the star: only the organization sets its default. */
  allowDefault: boolean;
  /** The organization already has a default, so a new provider does not star one. */
  hasDefault: boolean;
}

export function useModelChoice({
  provider,
  existing,
  discoverWith,
  tickAll,
  allowDefault,
  hasDefault,
}: ModelChoiceOptions) {
  const source = modelSource(provider);
  const search = useOpenRouterSearch(source === "search");
  const discover = useDiscoverModels();
  const [discovery, setDiscovery] = useState<DiscoveryState | null>(null);
  // A listing is only good for what it was asked against.
  const discoveryKey = JSON.stringify(discoverWith);
  const freshDiscovery = discovery?.key === discoveryKey ? discovery : null;

  const listed = useMemo((): ModelPickRow[] => {
    if (source === "search") return searchRows(search.models);
    if (source === "discover") {
      return freshDiscovery?.outcome === "ok" ? discoveredRows(freshDiscovery.models) : [];
    }
    return catalogRows(provider.models);
  }, [source, search.models, freshDiscovery, provider.models]);

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
    // A search lists hundreds: the operator picks, nothing is ticked for them.
    if (tickAll && source !== "search") for (const row of listed) map.set(row.id, row);
    return map;
  }, [existing, tickAll, source, listed]);
  const picked = touched ?? initial;

  const [starred, setStarred] = useState<string | null | undefined>(undefined);
  const currentDefault = existing.find((m) => m.is_default)?.modelId ?? null;
  // A new provider in an organization with no default offers its first recommended model.
  const suggested =
    tickAll && !hasDefault
      ? (listed.find((r) => r.featured && picked.has(r.id))?.id ??
        listed.find((r) => picked.has(r.id))?.id ??
        null)
      : null;
  const star = allowDefault
    ? starred === undefined
      ? (currentDefault ?? suggested)
      : starred
    : null;

  const plan = planModelChoice({ picked, existing, starred: star });
  const canSave =
    plan.add.length + plan.grant.length + plan.withdraw.length > 0 || plan.defaultModelId !== null;

  // The server refuses to switch off the default model: its box stays ticked until another model
  // is starred (in a list with no star, until another default is chosen elsewhere).
  const lockedId =
    currentDefault !== null && (!allowDefault || star === currentDefault) ? currentDefault : null;

  const change = (changed: ModelPickRow[], checked: boolean) => {
    const next = new Map(picked);
    for (const row of changed) {
      if (checked) next.set(row.id, row);
      else if (row.id !== lockedId) next.delete(row.id);
    }
    setTouched(next);
  };

  const detect = () => {
    if (!discoverWith) return;
    const key = discoveryKey;
    discover.mutate(
      {
        body: buildDiscoverBody({
          credentialId: "credentialId" in discoverWith ? discoverWith.credentialId : null,
          provider,
          inlineApiKey: "inlineApiKey" in discoverWith ? discoverWith.inlineApiKey : "",
          baseUrl: "baseUrl" in discoverWith ? discoverWith.baseUrl : "",
        }),
      },
      {
        onSuccess: (data) =>
          setDiscovery({
            key,
            outcome: data.outcome,
            models: data.models,
            truncated: data.truncated,
          }),
        onError: (err) =>
          setDiscovery({
            key,
            outcome: err instanceof ApiError && err.status === 429 ? "throttled" : "request_failed",
            models: [],
            truncated: false,
          }),
      },
    );
  };

  return {
    source,
    rows,
    search,
    picked,
    change,
    star,
    setStar: allowDefault ? setStarred : undefined,
    plan,
    canSave,
    lockedId,
    discovery: freshDiscovery,
    detecting: discover.isPending,
    detect,
  };
}

export type ModelChoice = ReturnType<typeof useModelChoice>;
