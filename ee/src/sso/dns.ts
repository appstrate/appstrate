// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { resolveTxt } from "node:dns/promises";
import { verificationRecordName, verificationRecordValue } from "./domain.ts";

/** Resolves the TXT records of a name: one array of character-strings per record. */
export type TxtResolver = (name: string) => Promise<string[][]>;

let systemResolver: TxtResolver = resolveTxt;

/** Test-only: install a resolver (the routes then use it) and return the previous one. */
export function swapTxtResolverForTesting(next: TxtResolver): TxtResolver {
  const previous = systemResolver;
  systemResolver = next;
  return previous;
}

/** Answers that mean "no such record", as opposed to a resolver failure. */
const ABSENT = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

/**
 * Whether `_appstrate.<domain>` carries `appstrate-domain-verification=<token>`.
 * A record split into several character-strings is joined first (RFC 7208
 * §3.3 practice). A resolver failure other than "no record" rejects: the
 * caller reports it as such rather than as a missing record.
 */
export async function hasVerificationRecord(
  domain: string,
  token: string,
  resolve: TxtResolver = systemResolver,
): Promise<boolean> {
  const expected = verificationRecordValue(token);
  let records: string[][];
  try {
    records = await resolve(verificationRecordName(domain));
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && ABSENT.has(code)) return false;
    throw err;
  }
  return records.some((chunks) => chunks.join("").trim() === expected);
}
