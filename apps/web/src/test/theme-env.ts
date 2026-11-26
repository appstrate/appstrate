// SPDX-License-Identifier: Apache-2.0

import { afterAll } from "bun:test";
import { installSpaStorage } from "./fake-storage.ts";

/**
 * What the definition diff reaches on import (the editor's theme store reads `matchMedia` and the
 * document root): call before the dynamic import of a module that draws it. Restored after the file.
 */
export function installThemeEnv(): void {
  installSpaStorage({ matchMedia: () => ({ matches: false, addEventListener: () => {} }) });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      documentElement: { classList: { add: () => {}, remove: () => {} } },
      querySelector: () => null,
      // Libraries that inject their stylesheet on import (sonner) meet this stub too.
      head: { appendChild: () => {} },
      createElement: () => ({ appendChild: () => {}, setAttribute: () => {} }),
      createTextNode: () => ({}),
    },
  });
  afterAll(() => {
    Reflect.deleteProperty(globalThis, "document");
  });
}
