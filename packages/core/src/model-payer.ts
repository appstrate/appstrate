// SPDX-License-Identifier: Apache-2.0

/**
 * Who pays a model call: the platform's key (`system`), an organization
 * credential (`org`), or a member's own credential (`user`). The order is the
 * `credential_source` pg enum's label order: append only, never reorder.
 */
export const MODEL_PAYERS = ["system", "org", "user"] as const;
export type ModelPayer = (typeof MODEL_PAYERS)[number];

/**
 * Whose credential serves a listed model, in the payers' vocabulary: `system`
 * for a built-in model served by the platform's key, `org` for a model bound to
 * an organization credential, `user` for an unbound model each member serves
 * with their own credential, and `managed` for an alias, whose backing is not
 * exposed.
 */
export const MODEL_BINDINGS = [...MODEL_PAYERS, "managed"] as const;
export type ModelBinding = (typeof MODEL_BINDINGS)[number];

/**
 * Who owns a stored model credential: the organization (`org`) or one member
 * (`user`). The platform's key is not stored, so `system` owns none.
 */
export const MODEL_CREDENTIAL_OWNERS = ["org", "user"] as const satisfies readonly ModelPayer[];
export type ModelCredentialOwner = (typeof MODEL_CREDENTIAL_OWNERS)[number];
