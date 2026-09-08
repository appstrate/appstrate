import type { BillingEmailType, BillingEmailPropsMap } from "./types.ts";
import { renderBillingEmail } from "./registry.ts";
import { logger } from "../logger.ts";

// Injected by the module's init() — platform provides these
let _sendMail: ((to: string, subject: string, html: string) => void) | null = null;
let _getRecipients: ((orgId: string) => Promise<string[]>) | null = null;
let _getOrgName: ((orgId: string) => Promise<string | null>) | null = null;

export function initBillingEmail(deps: {
  sendMail: (to: string, subject: string, html: string) => void;
  /**
   * Who this org's billing mail goes to — `resolveBillingRecipients` in
   * production. Injected rather than imported so the rendering half of this
   * module stays testable without a database.
   */
  getRecipients: (orgId: string) => Promise<string[]>;
  /** Required on `ModuleInitContext` at this module's `@appstrate/core` floor. */
  getOrgName: (orgId: string) => Promise<string | null>;
}): void {
  _sendMail = deps.sendMail;
  _getRecipients = deps.getRecipients;
  _getOrgName = deps.getOrgName;
}

/**
 * Best-effort org-name resolution — a failed lookup must never block the
 * billing email itself.
 */
async function resolveOrgName(
  getOrgName: (orgId: string) => Promise<string | null>,
  orgId: string,
): Promise<string | null> {
  try {
    return await getOrgName(orgId);
  } catch (err) {
    logger.warn("Failed to resolve org name for billing email", { err, orgId });
    return null;
  }
}

/**
 * Render and send a billing email to the org's billing recipients
 * (`emails/recipients.ts` decides who they are).
 * Fire-and-forget — errors are logged, never thrown.
 */
export function sendBillingEmail<T extends BillingEmailType>(
  orgId: string,
  type: T,
  props: BillingEmailPropsMap[T],
): void {
  if (!_sendMail || !_getRecipients || !_getOrgName) {
    logger.debug("Billing email skipped — transport not initialized", { type, orgId });
    return;
  }

  const sendMail = _sendMail;
  const getEmails = _getRecipients;
  const getOrgName = _getOrgName;

  void (async () => {
    try {
      const [emails, orgName] = await Promise.all([
        getEmails(orgId),
        resolveOrgName(getOrgName, orgId),
      ]);
      const { subject, html } = renderBillingEmail(type, props, { orgName });

      for (const to of emails) {
        sendMail(to, subject, html);
      }

      logger.debug("Billing email sent", { type, orgId, recipientCount: emails.length });
    } catch (err) {
      logger.error("Failed to send billing email", {
        err,
        type,
        orgId,
      });
    }
  })();
}
