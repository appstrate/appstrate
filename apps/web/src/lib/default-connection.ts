// SPDX-License-Identifier: Apache-2.0

/**
 * Whether the Connexions tab shows the default connection: to those who configure the integration,
 * in the working space, once the integration declares an auth. Activation does not gate it: a
 * default or an admin pin keeps a connection locked while the integration is switched off, and
 * only this section lifts it.
 */
export function showsDefaultConnection({
  canConfigure,
  fromWorkingSpace,
  authCount,
}: {
  canConfigure: boolean;
  fromWorkingSpace: boolean;
  authCount: number;
}): boolean {
  return canConfigure && fromWorkingSpace && authCount > 0;
}
