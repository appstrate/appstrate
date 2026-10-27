// SPDX-License-Identifier: Apache-2.0

import type { StateCreator } from "zustand";
import { persistedValue } from "./local-storage";

type Scalar<T, K extends string, S extends string> = { [P in K]: T } & {
  [P in S]: (value: T) => void;
};

/**
 * A store holding one scalar kept in localStorage under `storageKey`: `field`
 * starts from `parse` of what is stored, `setter` writes it back (`null`
 * removes the key). For `create` (a hook) or `createStore` (vanilla) alike.
 *
 * Each tab reads localStorage once on init and keeps its own state: no
 * cross-tab sync, so two tabs can hold different selections.
 */
export function persistedScalar<
  T extends string | boolean | null,
  K extends string,
  S extends string,
>(
  storageKey: string,
  parse: (raw: string | null) => T,
  field: K,
  setter: S,
): StateCreator<Scalar<T, K, S>> {
  const stored = persistedValue(storageKey, parse);
  return (set) =>
    ({
      [field]: stored.read(),
      [setter]: (value: T) => {
        stored.write(value);
        set({ [field]: value } as Partial<Scalar<T, K, S>>);
      },
    }) as Scalar<T, K, S>;
}
