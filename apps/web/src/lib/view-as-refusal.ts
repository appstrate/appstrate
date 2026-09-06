// SPDX-License-Identifier: Apache-2.0

/**
 * The ONE place a refused persona ends the preview.
 *
 * A persisted persona can stop being placeable between two sessions — the
 * space was deleted, the custom role removed, the caller demoted. The plan
 * forbids retrying without the header: the SPA would then silently answer with
 * the admin's real authority while the banner still claimed a preview. So the
 * first refused request drops the persona and says why.
 *
 * What it must NOT do is end the preview on a denial the persona correctly
 * earned — a 403 on a write a `viewer` cannot make, a 404 for a private space
 * they cannot see. That is the whole point of the preview. The server marks the
 * difference with a code (`VIEW_AS_REFUSAL_CODES`), which is a statement about
 * what failed rather than an inference from the shape of the answer.
 *
 * @see docs/architecture/RBAC_VIEW_AS_PLAN.md §4.5, §6.4
 */

import { VIEW_AS_HEADER, VIEW_AS_REFUSAL_CODES } from "@appstrate/core/permissions";
import { exitViewAs, viewAsStore } from "../stores/view-as-store";

/** Did this failure refuse the PERSONA, rather than the operation? */
export function isViewAsRefusal(code: string | undefined): boolean {
  return code !== undefined && VIEW_AS_REFUSAL_CODES.has(code);
}

/**
 * Called from the API client's response middleware for every failed request.
 * Only requests that actually carried the persona can refuse it.
 */
export async function noteViewAsRefusal(
  requestHeaders: Headers,
  response: Response,
): Promise<void> {
  if (!requestHeaders.has(VIEW_AS_HEADER)) return;
  if (!viewAsStore.getState().persona) return;

  const code = await readProblemCode(response);
  if (!isViewAsRefusal(code)) return;
  // The reason is handed to the store, not to a toast: this usually fires on
  // the boot-time org list, before the `<Toaster/>` exists (`view-as-banner.tsx`).
  exitViewAs(code);
}

async function readProblemCode(response: Response): Promise<string | undefined> {
  const body: { code?: unknown } = await response
    .clone()
    .json()
    .catch(() => ({}));
  return typeof body.code === "string" ? body.code : undefined;
}
