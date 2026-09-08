import { describe, expect, it } from "bun:test";
import { composeBillingRecipients } from "../../src/emails/recipients.ts";

/**
 * `billing_email ?? owners` ∪ `billing_cc` ∪ managers (RBAC spec §10). Each
 * case below removes exactly one term or one spelling, so a rule that stopped
 * applying fails here rather than silently widening who gets an invoice.
 */
describe("composeBillingRecipients", () => {
  const owners = ["owner@example.com"];

  it("falls back to the org owners when no contact is set", () => {
    expect(
      composeBillingRecipients({
        billingEmail: null,
        ownerEmails: owners,
        billingCc: [],
        managerEmails: [],
      }),
    ).toEqual(["owner@example.com"]);
  });

  it("replaces the owners with the contact when one is set", () => {
    expect(
      composeBillingRecipients({
        billingEmail: "billing@example.com",
        ownerEmails: owners,
        billingCc: [],
        managerEmails: [],
      }),
    ).toEqual(["billing@example.com"]);
  });

  it("adds the CC list to the contact", () => {
    expect(
      composeBillingRecipients({
        billingEmail: "billing@example.com",
        ownerEmails: owners,
        billingCc: ["cfo@example.com", "accounting@example.com"],
        managerEmails: [],
      }),
    ).toEqual(["billing@example.com", "cfo@example.com", "accounting@example.com"]);
  });

  it("adds the billing managers", () => {
    expect(
      composeBillingRecipients({
        billingEmail: null,
        ownerEmails: owners,
        billingCc: [],
        managerEmails: ["manager@example.com"],
      }),
    ).toEqual(["owner@example.com", "manager@example.com"]);
  });

  it("unions all three terms, contact first, then CC, then managers", () => {
    expect(
      composeBillingRecipients({
        billingEmail: "billing@example.com",
        ownerEmails: owners,
        billingCc: ["cfo@example.com"],
        managerEmails: ["manager@example.com"],
      }),
    ).toEqual(["billing@example.com", "cfo@example.com", "manager@example.com"]);
  });

  it("keeps the owners out once a contact is set, even when they manage billing", () => {
    // The owner still appears — through the MANAGER term, not the fallback.
    // Discriminating case: a composition that ignored `billingEmail` would put
    // the owner first instead of second.
    expect(
      composeBillingRecipients({
        billingEmail: "billing@example.com",
        ownerEmails: owners,
        billingCc: [],
        managerEmails: owners,
      }),
    ).toEqual(["billing@example.com", "owner@example.com"]);
  });

  it("de-duplicates across the terms, keeping the first spelling", () => {
    expect(
      composeBillingRecipients({
        billingEmail: "Billing@Example.com",
        ownerEmails: owners,
        billingCc: ["billing@example.com", "cfo@example.com"],
        managerEmails: ["CFO@example.com"],
      }),
    ).toEqual(["Billing@Example.com", "cfo@example.com"]);
  });

  it("is empty when the org has no owner, no contact, no CC and no manager", () => {
    expect(
      composeBillingRecipients({
        billingEmail: null,
        ownerEmails: [],
        billingCc: [],
        managerEmails: [],
      }),
    ).toEqual([]);
  });

  it("still reaches the CC list when the org has no owner to fall back to", () => {
    expect(
      composeBillingRecipients({
        billingEmail: null,
        ownerEmails: [],
        billingCc: ["accounting@example.com"],
        managerEmails: [],
      }),
    ).toEqual(["accounting@example.com"]);
  });
});
