// SPDX-License-Identifier: Apache-2.0

import type { StateCreator } from "zustand";
import type { LocalStore } from "@appstrate/ui/local-storage";

type Scalar<T, K extends string, S extends string> = { [P in K]: T } & {
  [P in S]: (value: T) => void;
};

/**
 * A store holding one scalar kept in `stored` (a `createLocalStore` of a scalar codec): `field`
 * starts from what is stored, `setter` writes it back (`null` removes the key). For `create` (a
 * hook) or `createStore` (vanilla) alike.
 *
 * The store's state is read once on init: a write from another tab reaches `stored` (it listens to
 * `storage` events) but not this store, so two tabs can hold different selections until reload.
 */
export function persistedScalar<
  T extends string | boolean | null,
  K extends string,
  S extends string,
>(stored: LocalStore<T>, field: K, setter: S): StateCreator<Scalar<T, K, S>> {
  return (set) =>
    ({
      [field]: stored.read(),
      [setter]: (value: T) => {
        stored.write(value);
        set({ [field]: value } as Partial<Scalar<T, K, S>>);
      },
    }) as Scalar<T, K, S>;
}
