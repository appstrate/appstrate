// SPDX-License-Identifier: Apache-2.0

/** Who may pay a model call with their own credentials: a platform user, or nobody. */
export type Payer = { readonly kind: "user"; readonly userId: string } | { readonly kind: "none" };

export const NO_PAYER: Payer = Object.freeze({ kind: "none" as const });

export function userPayer(userId: string): Payer {
  return { kind: "user", userId };
}

export function payerUserIdOf(payer: Payer): string | null {
  return payer.kind === "user" ? payer.userId : null;
}

/** The payer a run recorded at launch (`runs.payer_user_id`). */
export function persistedPayer(payerUserId: string | null): Payer {
  return payerUserId === null ? NO_PAYER : userPayer(payerUserId);
}
