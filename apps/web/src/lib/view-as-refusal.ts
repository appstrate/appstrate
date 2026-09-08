// SPDX-License-Identifier: Apache-2.0

/**
 * The ONE place a refused persona ends the preview — and never a denial the
 * persona correctly earned (a 403 on a write a `viewer` cannot make, a 404 for
 * a space they cannot see), which is the whole point of it. The server marks
 * the difference with a code (`VIEW_AS_REFUSAL_CODES`) rather than leaving it
 * to be inferred from the shape of the answer.
 *
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md §6.7
 */

import { VIEW_AS_HEADER, VIEW_AS_REFUSAL_CODES } from "@appstrate/core/permissions";
import { exitViewAs, viewAsStore } from "../stores/view-as-store";

/** Did this failure refuse the PERSONA, rather than the operation? */
function isViewAsRefusal(code: string | undefined): boolean {
  return code !== undefined && VIEW_AS_REFUSAL_CODES.has(code);
}

/**
 * End the preview if this failed response refused the PERSONA, and say whether
 * it did — a caller that would otherwise retry has to stop. The guard is "a
 * preview is running", not "this request carried the header": the SSE routes
 * carry the persona as a query parameter.
 */
export async function endPreviewIfRefused(response: Response): Promise<boolean> {
  if (!viewAsStore.getState().persona) return false;
  const code = await readProblemCode(response);
  if (!isViewAsRefusal(code)) return false;
  exitViewAs(code);
  return true;
}

/** Response middleware hook: only a request that carried the persona can refuse it. */
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
