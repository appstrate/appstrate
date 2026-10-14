// SPDX-License-Identifier: Apache-2.0

/**
 * The `SaveFeedback` of one setting when a mutation writes several: only a write
 * whose body carried `key` is that setting's, so saving a second field does not
 * say « Enregistré » under the first.
 */
export function fieldWriteState(
  mutation: {
    isPending: boolean;
    isSuccess: boolean;
    isError: boolean;
    variables?: { body?: object };
  },
  key: string,
): { pending: boolean; success: boolean; error: boolean } {
  const mine = !!mutation.variables?.body && key in mutation.variables.body;
  return {
    pending: mine && mutation.isPending,
    success: mine && mutation.isSuccess,
    error: mine && mutation.isError,
  };
}
