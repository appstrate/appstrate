// SPDX-License-Identifier: Apache-2.0

/**
 * A lazy chunk that can be loaded ahead of its first render.
 *
 * Downloading a chunk early is not enough with `React.lazy`: its factory runs
 * only on the first render, gets a promise even for a module already in
 * memory, and suspends on it. The Suspense fallback commits, and React then
 * holds it for its reveal throttle (~300 ms) — the same wait as a cold load.
 * Measured on the catalogue: 330 ms with its chunks fetched seconds before.
 *
 * So the module is remembered here once loaded, and the component renders it
 * synchronously from then on; `lazy` only stands in while it is not.
 */
import { lazy, type ComponentType } from "react";

export interface Chunk<M> {
  /** Starts the download, or returns the one in flight. A failure can be retried. */
  load: () => Promise<M>;
}

const loadedModules = new WeakMap<Chunk<unknown>, unknown>();

export function chunk<M>(importer: () => Promise<M>): Chunk<M> {
  let pending: Promise<M> | undefined;
  const self: Chunk<M> = {
    load: () =>
      (pending ??= importer().then(
        (module) => {
          loadedModules.set(self, module);
          return module;
        },
        (error: unknown) => {
          pending = undefined;
          throw error;
        },
      )),
  };
  return self;
}

/** The component `pick` names in `source`: rendered at once when loaded, through `lazy` otherwise. */
export function chunkComponent<M, P extends object>(
  source: Chunk<M>,
  pick: (module: M) => ComponentType<P>,
): ComponentType<P> {
  const Lazy = lazy(() => source.load().then((module) => ({ default: pick(module) })));
  function ChunkComponent(props: P) {
    const module = loadedModules.get(source) as M | undefined;
    const Loaded = module === undefined ? Lazy : pick(module);
    return <Loaded {...props} />;
  }
  return ChunkComponent;
}
