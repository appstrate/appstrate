// SPDX-License-Identifier: Apache-2.0

import { createTransport, type Transporter } from "nodemailer";
import { getEnv } from "@appstrate/env";
import { renderEmail, type EmailType, type EmailPropsMap } from "@appstrate/emails";
import { getAppConfig } from "../lib/app-config.ts";
import { logger } from "../lib/logger.ts";

const env = getEnv();

let transport: Transporter | null = null;

function getTransport(): Transporter {
  if (!transport) {
    transport = createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }
  return transport;
}

export async function sendMail(to: string, subject: string, html: string): Promise<void> {
  try {
    await getTransport().sendMail({ from: env.SMTP_FROM, to, subject, html });
  } catch (err) {
    logger.error("Failed to send email", { err, to, subject });
  }
}

/**
 * Render and send an email. Fire-and-forget — errors are logged, never thrown.
 * Safe to call with `void sendEmail(...)` — rendering and transport failures
 * are caught and logged, never propagated to the caller.
 */
export function sendEmail<T extends EmailType>(
  type: T,
  props: EmailPropsMap[T] & { to: string },
): void {
  if (!getAppConfig().features.smtp) return;
  try {
    const { subject, html } = renderEmail(type, props);
    void sendMail(props.to, subject, html);
  } catch (err) {
    logger.error("Failed to render email", {
      err,
      type,
      to: props.to,
    });
  }
}
