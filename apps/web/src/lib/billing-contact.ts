// SPDX-License-Identifier: Apache-2.0

/**
 * The billing-contact form's payload, as pure data.
 *
 * `PATCH /api/billing/contact` merges: an omitted field is left as it is, and
 * `billing_email: null` clears the address so invoices fall back to the
 * organization's owners. So the emitted body carries the fields that actually
 * changed, and the difference between "left alone" (absent) and "cleared"
 * (`null`) is decided here rather than by whichever `undefined` a form control
 * happened to produce.
 */

import { z } from "zod";
import type { components } from "../api/client";

export type BillingContact = components["schemas"]["EeBillingContact"];

/**
 * How many CC addresses the server accepts — mirrors `MAX_BILLING_CC` in
 * `packages/module-ee/src/billing/contact.ts`. The OpenAPI document does carry
 * it (`maxItems`, `packages/module-ee/src/openapi.ts`), but `openapi-typescript`
 * drops every validation keyword when it generates `api/schema.d.ts`, so the
 * ceiling cannot be read off the generated types.
 */
export const MAX_BILLING_CC = 5;

const EMAIL = z.email();

/** Whether the server's `z.email()` would accept this address. */
export function isBillingEmail(value: string): boolean {
  return EMAIL.safeParse(value).success;
}

/**
 * Split one typed line into addresses. Commas, semicolons and whitespace all
 * separate, because a list of addresses is routinely pasted from a mail client
 * that joined it with any of them.
 */
export function parseCcEntries(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The form's editable state: the primary address as typed, plus the CC list. */
export interface BillingContactDraft {
  billing_email: string;
  billing_cc: string[];
}

/** The contact as the form holds it — `null` becomes the empty field. */
export function toBillingContactDraft(contact: BillingContact): BillingContactDraft {
  return { billing_email: contact.billing_email ?? "", billing_cc: [...contact.billing_cc] };
}

export type BillingContactPatch = {
  billing_email?: string | null;
  billing_cc?: string[];
};

/**
 * The `PATCH` body: only the fields that differ from `current`.
 *
 * An emptied primary address is sent as `null` (clear it, fall back to the
 * owners) — never as `""`, which the server's `z.email()` refuses.
 */
export function billingContactPatch(
  current: BillingContact,
  draft: BillingContactDraft,
): BillingContactPatch {
  const patch: BillingContactPatch = {};

  const typed = draft.billing_email.trim();
  const email = typed.length === 0 ? null : typed;
  if (email !== current.billing_email) patch.billing_email = email;

  const cc = draft.billing_cc;
  const changed =
    cc.length !== current.billing_cc.length || cc.some((a, i) => a !== current.billing_cc[i]);
  if (changed) patch.billing_cc = [...cc];

  return patch;
}

/** Whether `patch` carries anything at all — an empty body is not worth a request. */
export function hasBillingContactChanges(patch: BillingContactPatch): boolean {
  return Object.keys(patch).length > 0;
}

/**
 * What committing the CC field's pending text does to the list.
 *
 * The input is a staging area, not a value: an address the operator typed but
 * never turned into a chip is still an address they asked for, so blur and Save
 * both commit through here rather than discarding it.
 */
export type CcCommit =
  { ok: true; billing_cc: string[] } | { ok: false; reason: "invalid" | "limit" };

export function commitCcInput(
  raw: string,
  current: readonly string[],
  max: number = MAX_BILLING_CC,
): CcCommit {
  const entries = parseCcEntries(raw);
  if (entries.length === 0) return { ok: true, billing_cc: [...current] };
  if (entries.some((entry) => !isBillingEmail(entry))) return { ok: false, reason: "invalid" };

  const merged = [...current];
  for (const entry of entries) if (!merged.includes(entry)) merged.push(entry);
  if (merged.length > max) return { ok: false, reason: "limit" };
  return { ok: true, billing_cc: merged };
}
