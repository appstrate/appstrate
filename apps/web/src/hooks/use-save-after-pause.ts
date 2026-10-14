// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";

const SAVE_PAUSE_MS = 650;

/**
 * The timer behind `useSaveAfterPause`, apart from React so its rules can be
 * driven directly: only a new `value` (or `edited` turning on) re-arms it, the
 * callbacks are read when it fires, and `flush` sends a pending save at once.
 */
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
 * Debounced save of a value edited continuously (typing, a slider): `save`
 * runs a pause after the last change of `value`, after `done` clears the
 * caller's edited flag. A save still pending when the component unmounts or
 * the page is hidden is sent right away, so leaving never drops the last edit.
 *
 * `value` must keep its identity between renders that did not change it
 * (state, or a memo of state): it is what re-arms the timer.
 */
export function useSaveAfterPause<T>(
  value: T,
  edited: boolean,
  save: (value: T) => void,
  done: () => void,
) {
  const [saver] = useState(() => createPauseSaver<T>());
  useEffect(() => saver.sync(value, edited, save, done));
  useEffect(() => {
    window.addEventListener("pagehide", saver.flush);
    return () => {
      window.removeEventListener("pagehide", saver.flush);
      saver.flush();
    };
  }, [saver]);
}
