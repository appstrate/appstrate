// SPDX-License-Identifier: Apache-2.0

/**
 * The body `PATCH /api/billing/contact` receives.
 *
 * The route MERGES: an omitted field is left alone, `billing_email: null`
 * clears the contact back to the organization's owners, and `""` is refused by
 * the server's `z.email()`. Those three are one decision, made here.
 */

import { describe, expect, it } from "bun:test";
import {
  MAX_BILLING_CC,
  billingContactPatch,
  commitCcInput,
  hasBillingContactChanges,
  isBillingEmail,
  parseCcEntries,
  toBillingContactDraft,
  type BillingContact,
} from "../billing-contact.ts";

const SET: BillingContact = {
  billing_email: "compta@acme.test",
  billing_cc: ["cfo@acme.test"],
};
const FALLBACK: BillingContact = { billing_email: null, billing_cc: [] };

describe("the PATCH body", () => {
  it("carries only the field that changed", () => {
    expect(
      billingContactPatch(SET, {
        billing_email: "paie@acme.test",
        billing_cc: [...SET.billing_cc],
      }),
    ).toEqual({
      billing_email: "paie@acme.test",
    });
    expect(billingContactPatch(SET, { billing_email: SET.billing_email!, billing_cc: [] })).toEqual(
      {
        billing_cc: [],
      },
    );
  });

  it("sends null — not an empty string — to fall back to the owners", () => {
    expect(
      billingContactPatch(SET, { billing_email: "  ", billing_cc: [...SET.billing_cc] }),
    ).toEqual({
      billing_email: null,
    });
  });

  it("emits nothing at all when the form matches the server", () => {
    const patch = billingContactPatch(SET, toBillingContactDraft(SET));
    expect(patch).toEqual({});
    expect(hasBillingContactChanges(patch)).toBe(false);
  });

  it("does not re-send null for a contact that is already unset", () => {
    expect(billingContactPatch(FALLBACK, toBillingContactDraft(FALLBACK))).toEqual({});
  });

  it("trims the address the operator typed", () => {
    expect(
      billingContactPatch(FALLBACK, { billing_email: " compta@acme.test ", billing_cc: [] }),
    ).toEqual({ billing_email: "compta@acme.test" });
  });

  it("reports a reordered CC list as a change, since order is what is stored", () => {
    const current: BillingContact = {
      billing_email: null,
      billing_cc: ["a@acme.test", "b@acme.test"],
    };
    expect(
      billingContactPatch(current, {
        billing_email: "",
        billing_cc: ["b@acme.test", "a@acme.test"],
      }),
    ).toEqual({ billing_cc: ["b@acme.test", "a@acme.test"] });
  });
});

describe("the CC input", () => {
  it("splits a pasted list on commas, semicolons and whitespace", () => {
    expect(parseCcEntries("a@acme.test, b@acme.test;c@acme.test  d@acme.test")).toEqual([
      "a@acme.test",
      "b@acme.test",
      "c@acme.test",
      "d@acme.test",
    ]);
    expect(parseCcEntries("   ")).toEqual([]);
  });

  it("validates each address the way the server does", () => {
    expect(isBillingEmail("compta@acme.test")).toBe(true);
    expect(isBillingEmail("compta@")).toBe(false);
    expect(isBillingEmail("")).toBe(false);
  });

  it("mirrors the server's CC ceiling", () => {
    expect(MAX_BILLING_CC).toBe(5);
  });
});

describe("committing the CC text", () => {
  it("appends what was typed but never turned into a chip", () => {
    expect(commitCcInput("cfo@acme.test", ["compta@acme.test"])).toEqual({
      ok: true,
      billing_cc: ["compta@acme.test", "cfo@acme.test"],
    });
  });

  it("leaves the list alone when nothing is pending", () => {
    expect(commitCcInput("   ", ["cfo@acme.test"])).toEqual({
      ok: true,
      billing_cc: ["cfo@acme.test"],
    });
  });

  it("refuses an address the server would refuse, and keeps the text to fix", () => {
    expect(commitCcInput("compta@", [])).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses a commit that would cross the ceiling", () => {
    const full = ["a@a.test", "b@a.test", "c@a.test", "d@a.test", "e@a.test"];
    expect(full.length).toBe(MAX_BILLING_CC);
    expect(commitCcInput("f@a.test", full)).toEqual({ ok: false, reason: "limit" });
  });

  it("ignores an address already on the list rather than duplicating it", () => {
    expect(commitCcInput("cfo@acme.test", ["cfo@acme.test"])).toEqual({
      ok: true,
      billing_cc: ["cfo@acme.test"],
    });
  });
});
