// SPDX-License-Identifier: Apache-2.0

/**
 * The few globals react-dom's client touches, for a test mounting a component that renders
 * nothing (a hook probe). There is no DOM harness in this repo: `installDomShim()` installs them
 * for the calling file and removes them after it; `container()` is a fresh root container, one
 * per mount, as `createRoot` wants.
 */

import { afterAll, beforeAll } from "bun:test";

const globals = globalThis as { window?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean };
const noop = () => {};
const doc: Record<string, unknown> = {
  addEventListener: noop,
  removeEventListener: noop,
  activeElement: null,
};

export function container(): HTMLElement {
  const node = {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    addEventListener: noop,
    removeEventListener: noop,
    ownerDocument: doc,
  };
  doc.documentElement = doc.body = node;
  return node as unknown as HTMLElement;
}

export function installDomShim(): void {
  const saved = { window: globals.window, act: globals.IS_REACT_ACT_ENVIRONMENT };
  beforeAll(() => {
    globals.window = { HTMLIFrameElement: class {}, document: doc };
    globals.IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    if (saved.window === undefined) delete globals.window;
    else globals.window = saved.window;
    globals.IS_REACT_ACT_ENVIRONMENT = saved.act;
  });
}
