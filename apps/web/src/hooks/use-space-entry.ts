// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import {
  useQueryClient,
  type FetchQueryOptions,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useSpaceAction } from "./use-space-action";

/** A read made before entering a space; resolves to the call that puts its answer back once there. */
type SpaceRead = (qc: QueryClient) => Promise<() => void>;

/** `options` read now, its answer put back on its key once the space is entered. */
export function spaceRead<T, E, K extends QueryKey>(
  options: FetchQueryOptions<T, E, T, K> & { queryKey: K },
): SpaceRead {
  const key: QueryKey = options.queryKey;
  return async (qc) => {
    const data: T = await qc.fetchQuery(options);
    return () => qc.setQueryData<T>(key, data);
  };
}

/**
 * `useSpaceAction` among `spaceIds` where `permission` holds; the reader chooses even when the
 * working space is among them unless `preferWorkingSpace` (a row of the working space).
 * Entering another space makes `readsIn(spaceId)` from that space first and puts them back once
 * entered (the switch drops the space's caches), so the screen redrawn there, and what the act
 * opens, hold that space's data without waiting. A failed read reports itself and enters nothing.
 * `entering` while it reads.
 */
export function useSpaceEntry(
  permission: string,
  spaceIds: readonly string[],
  readsIn: (spaceId: string) => readonly SpaceRead[],
  { preferWorkingSpace = false }: { preferWorkingSpace?: boolean } = {},
) {
  const { t } = useTranslation("common");
  const qc = useQueryClient();
  const [entering, setEntering] = useState(false);
  const action = useSpaceAction({ permission }, spaceIds, {
    preferWorkingSpace,
    prepare: async (spaceId, act) => {
      setEntering(true);
      try {
        const seeds = await Promise.all(readsIn(spaceId).map((read) => read(qc)));
        return () => {
          for (const seed of seeds) seed();
          act();
        };
      } catch (error) {
        toast.error(t("error.generic"));
        throw error;
      } finally {
        setEntering(false);
      }
    },
  });
  return { ...action, entering };
}

/** What a page hands the space line (`ConfigurationSpace`) and its deeds: {@link useSpaceEntry}'s result. */
export type SpaceEntry = ReturnType<typeof useSpaceEntry>;
