// SPDX-License-Identifier: Apache-2.0

// `PATCH /api/billing/contact` merges: an omitted field is left alone, `billing_email: null`
// clears it (invoices fall back to the owners). "Absent" vs `null` is decided here, not by
// whichever `undefined` a form control produced.

import { z } from "zod";
import type { components } from "../api/client";

export type BillingContact = components["schemas"]["EeBillingContact"];

/** Mirrors `MAX_BILLING_CC` in `packages/module-ee/src/billing/contact.ts`; `openapi-typescript` drops `maxItems`, so it cannot be read off the generated types. */
export const MAX_BILLING_CC = 5;

const EMAIL = z.email();

export function isBillingEmail(value: string): boolean {
  return EMAIL.safeParse(value).success;
}

// Commas, semicolons and whitespace all separate: pasted lists come from mail clients joining with any.
function parseCcEntries(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export interface BillingContactDraft {
  billing_email: string;
  billing_cc: string[];
}

export function toBillingContactDraft(contact: BillingContact): BillingContactDraft {
  return { billing_email: contact.billing_email ?? "", billing_cc: [...contact.billing_cc] };
}

export type BillingContactPatch = {
  billing_email?: string | null;
  billing_cc?: string[];
};

/** Only the fields that differ from `current`. An emptied address is `null`, never `""` (`z.email()` refuses it). */
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

export function hasBillingContactChanges(patch: BillingContactPatch): boolean {
  return Object.keys(patch).length > 0;
}

/** The CC input is a staging area: blur and Save both commit pending text through here rather than discarding it. */
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
