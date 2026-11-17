// SPDX-License-Identifier: Apache-2.0

/** The `ChatHost` and `ConversationScope` seams, faked for a render. */

import type { ConversationScope } from "../src/ui/conversation-scope.ts";
import type { ChatHost } from "../src/ui/runtime-context.ts";

/** A host granting everything, acting nowhere, keys echoed: `overrides` set what a test reads. */
export function testHost(overrides: Partial<ChatHost> = {}): ChatHost {
  return {
    openFile: () => {},
    downloadFile: () => {},
    useFileImageSrc: () => null,
    t: (key) => key,
    can: () => true,
    canIn: () => true,
    actingSpaceIds: [],
    personalModelCredentials: true,
    modelCredentials: [],
    formatBytes: String,
    onPackagesChanged: () => {},
    renderSpaces: (spaceIds) => spaceIds.join(", "),
    linkInSpace: (path) => path,
    useSpaceLabelOf: () => () => undefined,
    SpaceChoiceSubmenu: () => null,
    ...overrides,
  };
}

/** An idle, unlimited conversation without an origin: `overrides` set what a test reads. */
export function conversationScope(overrides: Partial<ConversationScope> = {}): ConversationScope {
  return {
    originSpaceId: null,
    restricted: false,
    generating: false,
    pending: false,
    limitTo: () => {},
    lift: () => {},
    ...overrides,
  };
}
