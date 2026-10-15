// SPDX-License-Identifier: Apache-2.0

/**
 * The ONE place a refused persona ends the preview — never a denial the persona
 * correctly earned (a 403 on a write a `viewer` cannot make). The server marks the
 * difference with a code (`VIEW_AS_REFUSAL_CODES`).
 *
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md §6.7
 */

import { VIEW_AS_HEADER, VIEW_AS_REFUSAL_CODES } from "@appstrate/core/permissions";
import { ApiError } from "../api/errors";
import { exitViewAs, viewAsStore } from "../stores/view-as-store";

function isViewAsRefusal(code: string | undefined): boolean {
  return code !== undefined && VIEW_AS_REFUSAL_CODES.has(code);
}

/** The refusal a thrown request names (copy: `viewAs.stopped.<code>`); `null` for an earned denial or a transport failure. */
export function viewAsRefusalCode(err: unknown): string | null {
  return err instanceof ApiError && isViewAsRefusal(err.code) ? err.code : null;
}

/**
 * End the preview if this failed response refused the PERSONA, and say whether it
 * did (a retrying caller must stop). The guard is "a preview is running", not
 * "this request carried the header": SSE routes carry the persona in the query.
 */
export async function endPreviewIfRefused(response: Response): Promise<boolean> {
  if (!viewAsStore.getState().persona) return false;
  const code = await readProblemCode(response);
  if (!isViewAsRefusal(code)) return false;
  exitViewAs(code);
  return true;
}

export async function noteViewAsRefusal(
  requestHeaders: Headers,
  response: Response,
): Promise<void> {
  if (!requestHeaders.has(VIEW_AS_HEADER)) return;
  await endPreviewIfRefused(response);
}

async function readProblemCode(response: Response): Promise<string | undefined> {
  const body: { code?: unknown } = await response
    .clone()
    .json()
    .catch(() => ({}));
  return typeof body.code === "string" ? body.code : undefined;
}
