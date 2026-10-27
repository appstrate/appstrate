// SPDX-License-Identifier: Apache-2.0

/**
 * The `SaveFeedback` of one setting when a mutation writes several: only a write
 * whose body carried one of the setting's `keys` is that setting's, so saving a
 * second field does not say « Enregistré » under the first. A setting written as
 * several fields (an appearance: `icon` or `color`) names them all.
 */
export function fieldWriteState(
  mutation: {
    isPending: boolean;
    isSuccess: boolean;
    isError: boolean;
    variables?: { body?: object };
  },
  keys: string | readonly string[],
): { pending: boolean; success: boolean; error: boolean } {
  const body = mutation.variables?.body;
  const mine = !!body && (typeof keys === "string" ? [keys] : keys).some((key) => key in body);
  return {
    pending: mine && mutation.isPending,
    success: mine && mutation.isSuccess,
    error: mine && mutation.isError,
  };
}
