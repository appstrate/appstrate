// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";

const SAVE_PAUSE_MS = 650;

/** The timer behind `useSaveAfterPause`, apart from React so it can be tested: only a new `value` (or `edited` turning on) re-arms it; `flush` sends a pending save at once. */
export function createPauseSaver<T>(delayMs = SAVE_PAUSE_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let armed: { value: T } | null = null;
  let callbacks: { save: (value: T) => void; done: () => void } | null = null;

  const cancel = () => {
    clearTimeout(timer);
    armed = null;
  };
  const flush = () => {
    if (!armed || !callbacks) return;
    const { value } = armed;
    cancel();
    callbacks.done();
    callbacks.save(value);
  };

  return {
    /** Called on every commit with the latest props. */
    sync(value: T, edited: boolean, save: (value: T) => void, done: () => void) {
      callbacks = { save, done };
      if (!edited) {
        cancel();
        return;
      }
      if (armed && Object.is(armed.value, value)) return;
      cancel();
      armed = { value };
      timer = setTimeout(flush, delayMs);
    },
    flush,
  };
}

/**
 * Debounced save of a continuously edited value: the returned `markEdited` arms it, `save` runs a
 * pause after the last change and clears the edited flag. A pending save is sent at unmount /
 * pagehide. `value` must keep its identity between renders that did not change it: it re-arms the
 * timer. While `enabled` is false an edit stays marked but nothing is saved.
 */
export function useSaveAfterPause<T>(value: T, save: (value: T) => void, enabled = true) {
  const [saver] = useState(() => createPauseSaver<T>());
  const [edited, setEdited] = useState(false);
  const markEdited = useCallback(() => setEdited(true), []);
  useEffect(() => saver.sync(value, edited && enabled, save, () => setEdited(false)));
  useEffect(() => {
    window.addEventListener("pagehide", saver.flush);
    return () => {
      window.removeEventListener("pagehide", saver.flush);
      saver.flush();
    };
  }, [saver]);
  return markEdited;
}
