// SPDX-License-Identifier: Apache-2.0

/** The composer's per-user preferences, bound together by the host on sign-in and switch. */

import { bindInlineRunModelUser } from "./inline-run-model-store.ts";
import { bindPackageAuthoringUser } from "./package-authoring-store.ts";

export function bindChatPreferencesUser(userId: string | null): void {
  bindPackageAuthoringUser(userId);
  bindInlineRunModelUser(userId);
}
