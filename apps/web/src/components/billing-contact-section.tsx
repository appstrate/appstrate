// SPDX-License-Identifier: Apache-2.0

import { useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { Field, FieldGroup } from "@appstrate/ui/components/field";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { getErrorMessage } from "@appstrate/core/errors";
import {
  useBillingContact,
  useBillingContactKey,
  useUpdateBillingContact,
} from "../hooks/use-billing";
import {
  MAX_BILLING_CC,
  billingContactPatch,
  commitCcInput,
  hasBillingContactChanges,
  isBillingEmail,
  toBillingContactDraft,
  type BillingContactDraft,
} from "../lib/billing-contact";
import { LoadingState, ErrorState } from "./page-states";
import { SectionCard } from "./section-card";
import { Spinner } from "./spinner";

/**
 * Where invoices, receipts and dunning mail go instead of every owner's inbox.
 *
 * Mounted only where `can("billing:manage")` holds — the condition the module's
 * admin routes check; the route around it already requires `billing:read`, a
 * permission only `@appstrate/module-ee` contributes. An empty primary address is not a
 * missing value: it is the org asking for the owners fallback, which is why
 * the form can clear the field and why the save sends `null` for it.
 *
 * The CC field's text is part of the form, not a scratch area: an address typed
 * but never turned into a chip is committed on blur and on Save, so it cannot
 * be silently dropped by the button the operator pressed to keep it.
 */
export function BillingContactSection() {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const contactQuery = useBillingContact();
  const contactKey = useBillingContactKey();
  const update = useUpdateBillingContact();

  const [draft, setDraft] = useState<BillingContactDraft | null>(null);
  const [ccInput, setCcInput] = useState("");
  const [ccError, setCcError] = useState<string | null>(null);

  if (contactQuery.isLoading) return <LoadingState />;
  if (contactQuery.error) return <ErrorState message={getErrorMessage(contactQuery.error)} />;

  const contact = contactQuery.data ?? { billing_email: null, billing_cc: [] };
  const current = draft ?? toBillingContactDraft(contact);
  const pendingCc = commitCcInput(ccInput, current.billing_cc);
  const patch = billingContactPatch(
    contact,
    pendingCc.ok ? { ...current, billing_cc: pendingCc.billing_cc } : current,
  );
  const dirty = hasBillingContactChanges(patch);
  const emailInvalid =
    current.billing_email.trim() !== "" && !isBillingEmail(current.billing_email.trim());
  const emailDescribed = emailInvalid || current.billing_email.trim() === "";

  const edit = (next: Partial<BillingContactDraft>) => setDraft({ ...current, ...next });

  /** Commit the CC text. Returns the resulting list, or `null` on a refusal. */
  const commitCc = (): string[] | null => {
    const result = commitCcInput(ccInput, current.billing_cc);
    if (!result.ok) {
      setCcError(
        result.reason === "limit"
          ? t("billingContact.ccLimit", { max: MAX_BILLING_CC })
          : t("validation.emailFormat", { ns: "common" }),
      );
      return null;
    }
    setCcError(null);
    setCcInput("");
    // `commitCcInput` only ever appends, so a same-length answer changed
    // nothing — writing a draft for it would arm Cancel over no edit.
    if (result.billing_cc.length !== current.billing_cc.length) {
      edit({ billing_cc: result.billing_cc });
    }
    return result.billing_cc;
  };

  // Enter, comma and space all commit the address being typed — the three
  // separators a pasted or hand-typed address list arrives with.
  const onCcKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" && event.key !== "," && event.key !== " ") return;
    event.preventDefault();
    commitCc();
  };

  const handleSave = () => {
    const cc = commitCc();
    if (cc === null) return;
    const body = billingContactPatch(contact, { ...current, billing_cc: cc });
    update.mutate(
      { body },
      {
        onSuccess: (data) => {
          queryClient.setQueryData(contactKey, data);
          setDraft(null);
          setCcInput("");
          setCcError(null);
          void queryClient.invalidateQueries({ queryKey: contactKey });
          toast.success(t("billingContact.saveSuccess"));
        },
        onError: (err) =>
          toast.error(t("error.prefix", { ns: "common", message: getErrorMessage(err) })),
      },
    );
  };

  return (
    <SectionCard title={t("billingContact.title")}>
      <p className="text-muted-foreground text-sm">{t("billingContact.description")}</p>

      <FieldGroup>
        <Field data-invalid={emailInvalid}>
          <Label htmlFor="billing-contact-email">{t("billingContact.emailLabel")}</Label>
          <Input
            id="billing-contact-email"
            type="email"
            autoComplete="email"
            placeholder="billing@example.com"
            value={current.billing_email}
            aria-invalid={emailInvalid}
            aria-describedby={emailDescribed ? "billing-contact-email-hint" : undefined}
            disabled={update.isPending}
            onChange={(event) => edit({ billing_email: event.target.value })}
          />
          {emailInvalid ? (
            <p id="billing-contact-email-hint" role="alert" className="text-destructive text-sm">
              {t("validation.emailFormat", { ns: "common" })}
            </p>
          ) : (
            current.billing_email.trim() === "" && (
              <p id="billing-contact-email-hint" className="text-muted-foreground text-sm">
                {t("billingContact.emailFallback")}
              </p>
            )
          )}
        </Field>

        <Field>
          <Label htmlFor="billing-contact-cc">{t("billingContact.ccLabel")}</Label>
          {current.billing_cc.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {current.billing_cc.map((address) => (
                <Badge key={address} variant="secondary" className="gap-1">
                  {address}
                  <button
                    type="button"
                    aria-label={t("billingContact.removeCcAriaLabel", { email: address })}
                    disabled={update.isPending}
                    onClick={() =>
                      edit({ billing_cc: current.billing_cc.filter((a) => a !== address) })
                    }
                  >
                    <X size={12} />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <Input
              id="billing-contact-cc"
              type="email"
              placeholder="email@example.com"
              value={ccInput}
              disabled={update.isPending || current.billing_cc.length >= MAX_BILLING_CC}
              aria-invalid={!!ccError}
              aria-describedby="billing-contact-cc-hint"
              onChange={(event) => {
                setCcInput(event.target.value);
                setCcError(null);
              }}
              onKeyDown={onCcKeyDown}
              onBlur={() => {
                if (ccInput.trim() !== "") commitCc();
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={update.isPending || ccInput.trim() === ""}
              onClick={commitCc}
            >
              {t("btn.add", { ns: "common" })}
            </Button>
          </div>
          {ccError ? (
            <p id="billing-contact-cc-hint" role="alert" className="text-destructive text-sm">
              {ccError}
            </p>
          ) : (
            <p id="billing-contact-cc-hint" className="text-muted-foreground text-sm">
              {t("billingContact.ccHint", { max: MAX_BILLING_CC })}
            </p>
          )}
        </Field>
      </FieldGroup>

      <div className="flex justify-end gap-2">
        {contact.billing_email !== null && (
          <Button
            variant="outline"
            size="sm"
            disabled={update.isPending || current.billing_email.trim() === ""}
            onClick={() => edit({ billing_email: "" })}
          >
            {t("billingContact.useOwners")}
          </Button>
        )}
        {draft !== null && (
          <Button
            variant="outline"
            size="sm"
            disabled={update.isPending}
            onClick={() => {
              setDraft(null);
              setCcInput("");
              setCcError(null);
            }}
          >
            {t("btn.cancel", { ns: "common" })}
          </Button>
        )}
        <Button
          size="sm"
          disabled={!dirty || emailInvalid || update.isPending}
          onClick={handleSave}
        >
          {update.isPending && <Spinner />}
          {t("btn.save", { ns: "common" })}
        </Button>
      </div>
    </SectionCard>
  );
}
