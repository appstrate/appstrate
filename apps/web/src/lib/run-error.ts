// SPDX-License-Identifier: Apache-2.0

import type { TFunction } from "i18next";

/** What the platform writes when a member stops a run; the only cancellation text it stores. */
const CANCELLED_BY_USER = "Cancelled by user";

/** A model provider's refusal, stored as `<http status> <JSON body>`. */
const PROVIDER_ERROR = /^(\d{3}) (\{[\s\S]*\})$/;

function providerMessage(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { error, message } = parsed as { error?: { message?: unknown }; message?: unknown };
    const found = error?.message ?? message;
    return typeof found === "string" && found.trim() ? found.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The sentence a run's stored `error` is shown as, in a list or on the run itself. The run
 * keeps whatever ended it verbatim (an English platform line, a provider's JSON body); the
 * screen says it in the reader's language.
 */
export function runErrorText(run: { status: string; error?: string | null }, t: TFunction): string {
  const raw = run.error ?? "";
  if (run.status === "cancelled" && raw === CANCELLED_BY_USER) return t("run.cancelledByUser");
  const provider = PROVIDER_ERROR.exec(raw);
  if (!provider) return raw;
  const status = Number(provider[1]);
  if (status === 401 || status === 403) return t("run.error.modelRefused");
  if (status === 429) return t("run.error.modelRateLimited");
  const message = providerMessage(provider[2]!);
  return message ? t("run.error.model", { status, message }) : raw;
}
