// SPDX-License-Identifier: Apache-2.0

/** The `ChatHost` seam, faked for a render. */

import type { ChatHost } from "../src/ui/runtime-context.ts";

/** A host granting everything, acting nowhere, keys echoed: `overrides` set what a test reads. */
export function testHost(overrides: Partial<ChatHost> = {}): ChatHost {
  return {
    openFile: () => {},
    downloadFile: () => {},
    useFileImageSrc: () => null,
    t: (key) => key,
    can: () => true,
    actingSpaceIds: [],
    personalModelCredentials: true,
    modelCredentials: [],
    formatBytes: String,
    onPackagesChanged: () => {},
    ...overrides,
  };
}
